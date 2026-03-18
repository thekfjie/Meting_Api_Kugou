import { getKugouAccountStatus } from '../utils/kugou-account-status.js'

export default async (c) => {
  const force = c.req.query('refresh') === '1'
  const data = await getKugouAccountStatus(force)
  c.header('cache-control', 'no-store')
  return c.json(data)
}
