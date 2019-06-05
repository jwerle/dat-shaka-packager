const hyperdrive = require('hyperdrive')
const replicate = require('hypercore-replicate')
const WebSocket = require('simple-websocket')
const packager = require('./')
const storage = require('dat-storage')
const rimraf = require('rimraf')

const server = packager.createServer({
  discovery: {
    key: '66dea7bef181330e5454c6a4cb7b848d838631ebb9e1bcd73b1bafb78bf51ae2'
  }
})

server.listen(3000, onlistening)

function onlistening(err) {
  if (err) {
    console.error('ERR', err)
    process.exit(1)
  }

  console.log('Listening on', server.address())
}
