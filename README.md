dat-shaka-packager
==================

> [Shaka Packager](https://github.com/google/shaka-packager) over the DAT network.

## Installation

```sh
$ npm install dat-shaka-packager
```

## Usage

The `dat-shaka-packager` module exposes a constructor for creating a
[hypersource](https://github.com/jwerle/hypersource) server and a peer
in the DAT network that uses
[shaka-packager](https://github.com/google/shaka-packager) to package a
set of inputs into a MPEG-DASH manifest and/or HLS playlist and provide
that output as an ephemeral archive returned in the same replication
stream. The public key for a `dat-shaka-packager` peer is used for
discovery and the initial replication stream. Ephemeral public keys are
exchanged as user data (`userData`) in the
[hypercore-protocol](https://github.com/mafintosh/hypercore-protocol)
handshake.

See _[protocol][#protocol]_ for more details on how this works.

## Example

```js
const packager = require('dat-shaka-packager')
const crypto = require('crypto')

// An ephemeral "public key" without a secret key that can be
// used for peer discovery and as the first key in a hypercore
// replication stream. You'll likely want to just give this to a
// hyperdrive instance
const key = crypto.randomBytes(32)
const node = packager({
  discovery: { key },
  storage: {
    cache: '/path/to/packager/cache',
    tmp: '/path/to/packager/tmpdir',
  },
})

node.listen(3000)
```

### Connecting To Peer

The example below connects to a peer with a known public key, gets a
ephemeral response public key from the replication user data, and
replicates that response from the stream tied to that public key. The
response is the packaged output from the input

See [jwerle/dat-shaka-packager-example](
https://github.com/jwerle/dat-shaka-packager-example) for a complete
example.

```js
const hyperdrive = require('hyperdrive')
const protocol = require('hypercore-protocol')
const storage = require('dat-storage')
const crypto = require('hypercore-crypto')
const rimraf = require('rimraf')
const swarm = require('discovery-swarm')
const path = require('path')
const ram = require('random-access-memory')

const TIMEOUT = 1000
const dirname = './input'
const key = '3546e77a133f01721058fb96cd9034d2cbf1e665eb040455e6eec614a8206bb7'

function connect(key, dirname, callback) {
  const opts = require('dat-swarm-defaults')({ hash: false, stream: onstream })
  const input = hyperdrive(storage(dirname), { latest: true })
  const discovery = swarm(opts)
  const discoveryKey = crypto.discoveryKey(Buffer.from(key, 'hex'))

  let connected = false
  let retries = 3

  input.ready(onready)

  discovery.on('error', onerror)
  input.on('error', onerror)

  function onerror(err) {
    connected = false
    if (0 === --retries) {
      callback(err)
    }
  }

  function onready() {
    discovery.join(discoveryKey)
  }

  function onstream() {
    const stream = protocol({ live: true, userData: input.key })
    stream.feed(Buffer.from(key, 'hex'))
    stream.once('handshake', onhandshake)
    stream.once('error', callback)
    return stream

    function onhandshake() {
      if (connected) {
        return stream.finalize()
      }

      connected = true
      const key = stream.remoteUserData.toString('hex')
      const output = path.join(`./tmp/${key}`)
      const response = hyperdrive(storage(output), key, { latest: true })

      let timeout = setTimeout(ontimeout, TIMEOUT)

      response.replicate({ stream, live: true })
      input.replicate({ stream, live: true })

      response.on('error', callback)
      response.on('sync', onsync)
      response.on('update', () => {
        clearTimeout(timeout)
        timeout = setTimeout(ontimeout, TIMEOUT)
      })

      function onsync() {
        clearTimeout(ontimeout)
        stream.destroy()
        discovery.close()
        callback(null, response)
      }

      function ontimeout() {
        connected = false
        stream.destroy()
        rimraf(output, (err) => err && console.error(err))
      }
    }
  }
}

connect(key, dirname, (err, res) => {
  if (err) {
    console.error('ERR', err.message)
    return process.exit(1)
  }

  console.log('packaged %s at %s', dirname, key)
  res.readdir('/', (err, files) => {
    if (err) {
      console.error('ERR', err.message)
      return process.exit(1)
    }

    console.log(files)
    process.nextTick(process.exit, 0)
  })
})
```

## Protocol

The `dat-shaka-packager` works by running a
[hypersource](https://github.com/jwerle/hypersource) server and
advertising itself as a service in the DAT network that can be connected to
with the intent to send a DAT archive containing inputs and a manifest
that should be packaged with the [shaka-packager](
https://github.com/google/shaka-packager).

Peers in the DAT network can discover this service with modules like
[discovery-swarm](https://github.com/mafintosh/discovery-swarm) using
[dat-swarm-defaults](https://github.com/datproject/dat-swarm-defaults).

### Discovery

1. Join network based on `discoveryKey(key)` where `key` is the shared
   public key for a `dat-shaka-packager` peer service
2. Upon peer discovery, initiate a `live` replication stream with
   `userData` based on `key` where `key` is the shared public key for a
   `dat-shaka-packager` peer service and `userData` is the public key
   for the input DAT archive that will be sent to the service. (_See [key
   exchange][#key-exchange] for more information_)
3. Wait for `'handshake'` event on the replication stream.

### Key Exchange

The key exchange between peers is achieved by leveraging the `userData`
field in the [replication
protocol](https://github.com/mafintosh/hypercore-protocol). Peers
connect to a `dat-shaka-packager` service by leveraging a shared public
key to discovery and establish a secure connection between connecting parties.

When Alice (peer) connects to Bob (service) over the DAT network, she
communicates the public key of her DAT archive containing her inputs to
Bob through the user data field in the replication protocol. Bob generates
an ephemeral key pair and communicates the public key to Alice the same
way. The ephemeral public key is part of the key pair that is used as
the response DAT archive Bob will send to Alice.

### Request Archive

The request (input) DAT archive is the file system containing all of the
inputs that will be packaged by `shaka-packager`. The archive should
contain a `manifest.json` (_See [manifest][#manfiest] for more
information_) that describes how the `shaka-packager` will operate. The
`manifest.json` file is the first file read in the archive.

The structure of the archive should at least look something like:

```
/manifest.json
/... # other input files
```

The `dat-shaka-packager` will read the request archive "sparsely"
(`sparse: true`) and in "latest" mode (`latest: true`) attempting to download
files (specified in `manfiest.packager.streams`) specified in the
`manifest.json` file.

Below is an example request archive that contains a single `video.mp4` that
generates a MPEG-DASH manifest file `manifest.mpd`

```json
{
  "packager": {
    "mpd_output": "manifest.mpd",

    "streams": [
      {
        "in": "original.mp4",
        "stream": "audio",
        "output": "audio.mp4",
      },
      {
        "in": "original.mp4",
        "stream": "video",
        "output": "video.mp4",
      }
    ]
  }
}
```

### Response Archive

The response (output) DAT archive is the file system containing all of
the outputs that were generated by `shaka-packager`. For the given
manifest above the following output will be generated:

```
/audio.mp4
/manifest.mpd
/video.mp4
```

## API

## Manifest

The manifest (`manifest.json`) file serves as the arguments for the
`dat-shaka-packager` service. It is a JSON file that converts its
properties into suitable arguments for the `shaka-packager` command line
program. This section outlines some useful high level properties.

Before reading, you should be familiar with the
[shaka-packager Documentation](https://google.github.io/shaka-packager/html/documentation.html)

### `manifest.files`

An array of string patterns used to **white list** files into the output
directory.

The following is an example of a white list that ensure only `.mp4`,
`.mpd`, and `.m3u8` files are added to the output.

```json
...
  "files": [
    "*.mp4",
    "*.mpd",
    "*.m3u8"
  ],
...
```

### `manifest.ignore`

An array of string patterns used to **black list** files into the output
directory.

The following is an example of a black list that ensures files with the
`h264_(baseline|main|high)_(360p|480p|720p|1080p)_(600|1000|3000|6000).mp4`
pattern are not added to the output.

```json
...
  "ignore": [
    "h264_(baseline|main|high)_(360p|480p|720p|1080p)_(600|1000|3000|6000).mp4"
  ],
...
```

### `manifest.packager`

The `shaka-packager` configuration as a series of key-value pairs that
map directly to the [command line
arguments](https://google.github.io/shaka-packager/html/documentation.html)

All field names are preserved with the exception of the
`manifest.packager.streams` and
`manifest.packager.keys` fields which are transformed into the correct
input for the `shaka-packager` command line arguments.

The following `manifest.json`

```json
{
  "packager": {
    "mpd_output": "manifest.mpd",

    "streams": [
      {
        "in": "original.mp4",
        "stream": "audio",
        "output": "audio.mp4",
      },
      {
        "in": "original.mp4",
        "stream": "video",
        "output": "video.mp4",
      }
    ]
  }
}
```

is converted into the following command:

```sh
$ packager \ 
  in=original.mp4,stream=audio,output=audio.mp4 \ 
  in=original.mp4,stream=video,output=video.mp4 \ 
  --mpd_output manifest.mpd
```

### `manifest.packager.streams[]`

An array of objects that describe stream inputs, outputs, and other
metadata that should be packaged. See [stream
descriptors](https://google.github.io/shaka-packager/html/documentation.html#stream-descriptors)
for a complete list of all the properties that can appear in this object.

```json
...
    "streams": [
      {
        "input": "original.mp4",
        "stream": "video",
        "output": "video.mp4",
        "format": "MP4"
        "drm_label": "audio"
      },
    ...
    ]
...
```

### `manifest.packager.keys[]`

An array of objects that map an encryption key to a stream. Below is an
example of an encryption key represented as a hex string
`0884cf8e9445bf2d6e10e5b88a8661d3` for the `"audio"` stream specified by
the `label` property that maps to the stream specified by the
`drm_label` properties in the `manfiest.packager.streams` array. The
encryption key is uniquely identified by the hex string
`a5308ea1375fb2f240d90fc29bad2c66`

```json
...
    "keys": [
      {
        "label": "audio",
        "key_id": "a5308ea1375fb2f240d90fc29bad2c66",
        "key": "0884cf8e9445bf2d6e10e5b88a8661d3"
      },
    ...
    ]
...
```

### Real World Manifest Example

Below is an example of a `manifest.json` that specifies how to generate
a [clear key encrypted](https://simpl.info/eme/clearkey/) MPEG-DASH manifest
and a HLS playlist for the following:

```json
{
  "files": [
    "*.mp4",
    "*.mpd",
    "*.m3u8"
  ],

  "ignore": [
    "h264_(baseline|main|high)_(360p|480p|720p|1080p)_(600|1000|3000|6000).mp4"
  ],

  "packager": {
    "enable_raw_key_encryption": true,
    "generate_static_mpd": true,
    "hls_master_playlist_output": "playlist.m3u8",
    "mpd_output": "manifest.mpd",

    "streams": [
      {
        "in": "h264_baseline_360p_600.mp4",
        "stream": "audio",
        "output": "audio.mp4",
        "drm_label": "audio"
      },
      {
        "in": "h264_baseline_360p_600.mp4",
        "stream": "video",
        "output": "h264_360p.mp4",
        "drm_label": "sd-360p-primary1"
      },
      {
        "in": "h264_main_480p_1000.mp4",
        "stream": "video",
        "output": "h264_480p.mp4",
        "drm_label": "sd-480p-primary1"
      },
      {
        "in": "h264_main_720p_3000.mp4",
        "stream": "video",
        "output": "h264_720p.mp4",
        "drm_label": "hd-720p-primary1"
      },
      {
        "in": "h264_high_1080p_6000.mp4",
        "stream": "video",
        "output": "h264_1080p.mp4",
        "drm_label": "hd-1080p-primary1"
      }
    ],

    "keys": [
      {
        "label": "audio",
        "key_id": "a5308ea1375fb2f240d90fc29bad2c66",
        "key": "0884cf8e9445bf2d6e10e5b88a8661d3"
      },
      {
        "label": "sd-360p-primary1",
        "key_id": "445da07a32a2c28de3ee0c00638708a3",
        "key": "88a1127789efd85478f21467a7a524e5"
      },
      {
        "label": "sd-480p-primary1",
        "key_id": "6465a536e3a87ec28b594a2a8e20af17",
        "key": "2d41d551367a30ed5b71f2dc4f22b802"
      },
      {
        "label": "hd-720p-primary1",
        "key_id": "da54aece6717796b7df729c75bdaa0f9",
        "key": "b39c2faae9b3d1406cc06239425536e5"
      },
      {
        "label": "hd-1080p-primary1",
        "key_id": "85d23925199895d562df2edc3a730b2c",
        "key": "57d9a65c5ce6ab56c468d26396074b82"
      }
    ]
  }
}
```

## License

MIT
