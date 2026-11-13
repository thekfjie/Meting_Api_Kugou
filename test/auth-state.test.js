import './setup.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import {
  getKugouAdminSession, setKugouAdminSession, getKugouAdminPoolState,
  setKugouAdminPoolState, getKugouAdminStatePath
} from '../src/utils/kugou-admin-state.js'

test('migrates a pending legacy login without losing the other pool', async () => {
  await mkdir('data', { recursive: true })
  await writeFile(getKugouAdminStatePath(), JSON.stringify({
    sessions: { qrLogin: { pool: 'general', key: 'old-qr', expiresAt: Date.now() + 60000 } }
  }))
  assert.equal((await getKugouAdminSession('qrLogin', 'general')).key, 'old-qr')
  await setKugouAdminSession('qrLogin', { pool: 'premium', key: 'new-qr', expiresAt: Date.now() + 60000 })
  assert.equal((await getKugouAdminSession('qrLogin', 'general')).key, 'old-qr')
  assert.equal((await getKugouAdminSession('qrLogin', 'premium')).key, 'new-qr')
})

test('simultaneous pool and login updates survive atomic persistence', async () => {
  await Promise.all(Array.from({ length: 30 }, (_, i) => setKugouAdminPoolState(i % 2 ? 'general' : 'premium', { [`fixture${i}`]: i })))
  for (let i = 0; i < 30; i++) {
    assert.equal((await getKugouAdminPoolState(i % 2 ? 'general' : 'premium'))[`fixture${i}`], i)
  }
  const saved = JSON.parse(await readFile(getKugouAdminStatePath(), 'utf8'))
  assert.equal(saved.version, 2)
  assert.equal(saved.sessions.qrLogin.general.key, 'old-qr')
  assert.equal(saved.sessions.qrLogin.premium.key, 'new-qr')
})

test('expiring one login leaves the other version available', async () => {
  await setKugouAdminSession('smsLogin', { pool: 'premium', mobile: 'fixture', expiresAt: 1 })
  await setKugouAdminSession('smsLogin', { pool: 'general', mobile: 'fixture', expiresAt: Date.now() + 60000 })
  assert.equal(await getKugouAdminSession('smsLogin', 'premium'), null)
  assert.equal((await getKugouAdminSession('smsLogin', 'general')).pool, 'general')
})
