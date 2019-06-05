//const hyperdiscovery = require('hyperdiscovery')
const datSwarmDefaults = require('dat-swarm-defaults')
const hypersource = require('hypersource')
const hyperdrive = require('hyperdrive')
const { exec } = require('child_process')
const packager = require('shaka-packager-static')
const protocol = require('hypercore-protocol')
const storage = require('dat-storage')
const crypto = require('hypercore-crypto')
const extend = require('extend')
const mirror = require('mirror-folder')
const rimraf = require('rimraf')
const swarm = require('discovery-swarm')
const Batch = require('batch')
const debug = require('debug')('dat-shaka-packager')
const path = require('path')
const ram = require('random-access-memory')
const fs = require('fs')
const os = require('os')

const toHex = (b) => b && Buffer.from(b).toString('hex')

const defaults = Object.create({
  ignore: [],

  storage: {
    cache: path.join(__dirname, 'cache'),
    tmp: path.join(__dirname, 'tmp'),
  },

  discovery: datSwarmDefaults({
    maxConnections: os.cpus().length,
    hash: false,
    utp: true,
    tcp: true,
    dht: true,
  }),
})

module.exports = createNode

function createNode(opts) {
  opts = extend(true, Object.create(defaults), opts)

  const node = hypersource.createServer(onrequest)

  // ensure packager binary is executable
  fs.chmod(packager.path, 0o750, (err) => {
    if (err) {
      node.emit('error', err)
    }
  })

  rimraf(opts.storage.cache, (err) => err && debug(err))
  rimraf(opts.storage.tmp, (err) => err && debug(err))

  if (opts.discovery && opts.discovery.key) {
    const key = Buffer.from(opts.discovery.key, 'hex')
    const discoveryKey = crypto.discoveryKey(key)

    extend(true, opts.discovery, { stream: onstream })

    node.key = key
    node.discovery = swarm(opts.discovery)
    node.discoveryKey = discoveryKey

    node.discovery.join(discoveryKey)
  }

  return node

  function onrequest(req, res) {
    const rkey = toHex(res.key)
    const input = path.join(opts.storage.tmp, req.url)
    const output = path.join(opts.storage.cache, rkey)
    const source = hyperdrive(storage(input), req.key, {
      sparse: true,
      latest: true,
    })

    const destination = hyperdrive(storage(output), res.key, {
      secretKey: res.secretKey,
      latest: true
    })

    req.once('close', onclose)
    res.once('close', onclose)

    source.replicate(req)

    process.nextTick(build, { input, output, source, destination }, (err) => {
      if (err) {
        return onerror(err)
      }

      destination.replicate(res)
    })

    function onclose() {
      source.close()
      destination.close()
      rimraf(input, onerror)
      rimraf(output, onerror)
    }

    function onerror(err) {
      if (err) {
        debug(err)
        try {
          destination.close()
          source.close()
          req.end()
          res.end()
        } catch (err) {
          debug(err)
        }
      }
    }
  }

  function onstream() {
    const res = crypto.keyPair()
    const stream = protocol({ live: true, userData: res.publicKey })

    stream.feed(Buffer.from(opts.discovery.key, 'hex'))
    stream.once('handshake', () => {
      const key = toHex(stream.remoteUserData)

      if (!key) {
        return stream.finalize()
      }

      const input = path.join(opts.storage.tmp, key)
      const output = path.join(opts.storage.cache, toHex(res.publicKey))
      const source = hyperdrive(storage(input), key, {
        latest: true,
        sparse: true,
      })

      const destination = hyperdrive(storage(output), res.publicKey, {
        secretKey: res.secretKey,
        latest: true
      })

      stream.once('close', onclose)
      stream.once('error', onerror)
      stream.once('end', onclose)

      source.replicate({ stream, live: true })

      const bopts = { input, output, source, destination }

      process.nextTick(build, bopts, (err) => {
        if (err) {
          return onerror(err)
        }

        destination.replicate({ stream, live: true })
        destination.content.on('upload', () => {
          const { uploadedBlocks } = destination.content.stats.totals
          const { length } = destination.content

          if (uploadedBlocks >= length) {
            destination.content.once('peer-remove', () => stream.finalize())
            return setTimeout(() => stream.finalize(), 500)
          }
        })

        destination.metadata.on('upload', () => {
          const { uploadedBlocks } = destination.metadata.stats.totals
          const { length } = destination.metadata

          if (uploadedBlocks >= length) {
            destination.metadata.once('peer-remove', () => stream.finalize())
            return setTimeout(() => stream.finalize(), 500)
          }
        })
      })

      function onclose() {
        source.close(() => rimraf(input, onerror))
        destination.close(() => rimraf(output, onerror))
      }

      function onerror(err) {
        if (err) {
          debug(err)
          try {
            stream.finalize()
          } catch (err) {
            debug(err)
          }
        }
      }
    })

    return stream
  }

  function build({ input, output, source, destination }, done) {
    let manifest = null
    let ignored = [ '.dat/', 'dat.json' ].concat(opts.ignore)
    let files = []

    source.once('error', done)
    destination.once('error', done)
    source.readFile('manifest.json', onmanifest)

    function onmanifest(err, buf) {
      if (err) {
        return done(err)
      }

      manifest = JSON.parse(buf)

      const { streams, keys } = manifest.packager
      const downloads = new Batch()
      const tasks = new Batch()
      const argv = [ packager.path ]

      files = manifest.files

      downloads.concurrency(os.cpus().length)
      tasks.concurrency(1)

      try {
        ignored = Array.from(new Set(
          ignored.concat(manifest.ignore)
          .filter((i) => i && i.length)
          .map((i) => i.replace(/^\*/, '.*'))
          .map((i) => i.replace(/\/\*/, '/.*'))
        ))
      } catch (err) {
        debug(err)
      }

      if (Array.isArray(files)) {
        files = Array.from(new Set(
          files
          .filter((i) => i && i.length)
          .map((i) => i.replace(/^\*/, '.*'))
          .map((i) => i.replace(/\/\*/, '/.*'))
        ))
      }

      // everything else is convert directly into flags
      delete manifest.packager.streams
      delete manifest.packager.keys

      for (const entry of streams) {
        const args = []

        for (const k in entry) {
          args.push(`${k}=${entry[k]}`)
        }

        if (entry.in) {
          downloads.push((done) => {
            source.stat(entry.in, (err) => {
              if (err) {
                return done(err)
              }
              source.download(entry.in, done)
            })
          })
        }

        argv.push(args.join(','))
      }

      for (const k in manifest.packager) {
        if ('boolean' === typeof manifest.packager[k] && manifest.packager[k]) {
          argv.push(`--${k}`)
        }

        if (
          'string' === typeof manifest.packager[k] ||
          'number' === typeof manifest.packager[k]
        ) {
          argv.push(`--${k} ${manifest.packager[k]}`)
        }
      }

      if (Array.isArray(keys) && keys.length) {
        argv.push('--keys')

        const flat = []

        for (const entry of keys) {
          const args = []

          for (const k in entry) {
            args.push(`${k}=${entry[k]}`)
          }

          flat.push(args.join(':'))
        }

        argv.push(flat.join(','))
      }

      tasks.push((done) => downloads.end(done))
      tasks.push((done) => exec(argv.join(' '), { cwd: input }, done))
      tasks.push((done) => {
        const opts = {
          ignore(filename) {
            let verdict = false

            if (files) {
              verdict = false === files.some((f) => RegExp(f).test(filename))
            }

            if (false === verdict) {
              verdict = ignored.some((i) => RegExp(i).test(filename))
            }

            debug('ignore: verdict=%b (%s)', verdict, filename)
            return verdict
          }
        }

        const from = { name: input }
        const to = { name: '/', fs: destination }

        mirror(from, to, opts, done)
      })

      tasks.end(done)
    }
  }
}
