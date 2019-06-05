const hyperdrive = require('hyperdrive')
const replicate = require('hypercore-replicate')
const WebSocket = require('simple-websocket')
const packager = require('./')
const storage = require('dat-storage')
const rimraf = require('rimraf')

const node = packager({
  discovery: {
    key: '3546e77a133f01721058fb96cd9034d2cbf1e665eb040455e6eec614a8206bb7',
    secretKey: 'a35a819166448913b81a0ab862573f4179ebb8d4bc2e871a600d80281355d7453546e77a133f01721058fb96cd9034d2cbf1e665eb040455e6eec614a8206bb7'
  }
})

node.listen(3000, onlistening)

function onlistening(err) {
  if (err) {
    console.error('ERR', err)
    process.exit(1)
  }

  console.log('Listening on', node.address())
}
