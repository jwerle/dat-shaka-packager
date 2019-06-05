//const hyperdiscovery = require('hyperdiscovery')
const datSwarmDefaults = require('dat-swarm-defaults')
const hypersource = require('hypersource')
const hyperdrive = require('hyperdrive')
const { exec } = require('child_process')
const packager = require('shaka-packager-static')
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

const toHex = (b) => b && Buffer.from(b).toString('hex')

const defaults = Object.create({
  ignore: [],

  storage: {
    cache: path.join(__dirname, 'cache'),
    tmp: path.join(__dirname, 'tmp'),
  },

  discovery: datSwarmDefaults({
    hash: false,
    utp: true,
    tcp: true,
    dht: true,
  }),
})

function createServer(opts) {
  opts = extend(true, Object.create(defaults), opts)

  const server = hypersource.createServer(onrequest)

  fs.chmod(packager.path, 0o750, (err) => {
    if (err) {
      server.emit('error', err)
    }
  })

  rimraf(opts.storage.cache, (err) => err && debug(err))
  rimraf(opts.storage.tmp, (err) => err && debug(err))

  if (opts.discovery) {
    const node = hyperdrive(ram, opts.discovery.key, opts.discovery)
    const discovery = swarm(extend(true, opts.discovery, {
      stream() {
        const res = crypto.keyPair()
        const stream = node.replicate({ live: true, userData: res.publicKey })
        stream.once('handshake', () => {
          const key = toHex(stream.remoteUserData)

          if (!key) {
            return stream.finalize()
          }

          const input = path.join(opts.storage.tmp, key)
          const output = path.join(opts.storage.cache, toHex(res.publicKey))
          const source = hyperdrive(storage(input), key, { latest: true })
          const destination = hyperdrive(storage(output), res.publicKey, {
            secretKey: res.secretKey,
            latest: true
          })

          stream.once('close', () => {
            source.close()
            destination.close()
            rimraf(input, onerror)
            rimraf(output, onerror)
          })

          source.replicate({ stream, live: true })

          const bopts = { input, output, source, destination }

          process.nextTick(build, bopts, (err) => {
            if (err) {
              return onerror(err)
            }

            let missing =  2
            destination.replicate({ stream, live: true })
            destination.content.on('upload', () => {
              const { uploadedBlocks } = destination.content.stats.totals
              const { length } = destination.content

              if (uploadedBlocks >= length) {
                destination.content.once('peer-remove', () => stream.finalize())
                return setTimeout(() => stream.finalize(), 500)
              }
            })

            const emit = destination.content.emit.bind(destination.content)
            destination.metadata.on('upload', () => {
              const { uploadedBlocks } = destination.metadata.stats.totals
              const { length } = destination.metadata

              if (uploadedBlocks >= length) {
                destination.metadata.once('peer-remove', () => stream.finalize())
                return setTimeout(() => stream.finalize(), 500)
              }
            })
          })

          function onerror(err) {
            if (err) {
              debug(err)
              try {
                destination.close()
                source.close()
              } catch (err) {
                debug(err)
              }
            }
          }
        })

        return stream
      }
    }))

    node.ready(() => discovery.join(node.discoveryKey))
    server.discovery = discovery
    server.node = node
  }

  return server

  function onrequest(req, res) {
    const rkey = toHex(res.key)
    const input = path.join(opts.storage.tmp, req.url)
    const output = path.join(opts.storage.cache, rkey)
    const source = hyperdrive(storage(input), req.key, { latest: true })
    const destination = hyperdrive(storage(output), res.key, {
      secretKey: res.secretKey,
      latest: true
    })

    req.once('close', () => {
      source.close()
      destination.close()
      rimraf(input, onerror)
      rimraf(output, onerror)
    })

    source.replicate(req)

    process.nextTick(build, { input, output, source, destination }, (err) => {
      if (err) {
        return onerror(err)
      }

      destination.replicate(res)
    })

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

  function build({ input, output, source, destination }, done) {
    let manifest = null
    let ignored = [ '.dat/', 'dat.json' ].concat(opts.ignore)
    let files = []

    source.once('sync', onsync)
    source.once('error', done)
    destination.once('error', done)

    function onsync() {
      source.readFile('manifest.json', onmanifest)
    }

    function onmanifest(err, buf) {
      if (err) {
        return done(err)
      }

      manifest = JSON.parse(buf)

      const { streams, keys } = manifest.packager
      const batch = new Batch()
      const argv = [ packager.path ]

      files = manifest.files
      batch.concurrency(1)

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

      batch.push((done) => {
        exec(argv.join(' '), { cwd: input }, done)
      })

      batch.push((done) => {
        const opts = {
          ignore: (filename) => {
            let verdict = false

            if (files) {
              verdict = false === files.some((f) => RegExp(f).test(filename))
            } else {
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

      batch.end(done)
    }
  }
}

module.exports = {
  createServer
}
