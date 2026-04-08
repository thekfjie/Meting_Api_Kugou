let lastTrace = null

export const recordKugouUpstreamTrace = (trace = {}) => {
  lastTrace = {
    at: new Date().toISOString(),
    status: 'miss',
    type: '',
    pool: '',
    configured: false,
    attempted: false,
    ...trace
  }
  return lastTrace
}

export const getKugouUpstreamTrace = () => lastTrace
