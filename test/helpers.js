import { createServer } from 'node:http'
import { once } from 'node:events'

export const createMockUpstream = async handler => {
  const requests = []
  const server = createServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += chunk
    const request = { url: new URL(req.url, 'http://localhost'), headers: req.headers, body: text }
    requests.push(request)
    handler(request, res)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise(resolve => {
      server.close(resolve)
      server.closeAllConnections()
    })
  }
}

export const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
