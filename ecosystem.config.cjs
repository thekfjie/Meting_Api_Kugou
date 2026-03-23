const path = require('node:path')

module.exports = {
  apps: [
    {
      name: 'kugou-upstream',
      cwd: path.resolve(__dirname, './KuGouMusicApi'),
      script: 'app.js',
      interpreter: 'node',
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'meting-api',
      cwd: __dirname,
      script: 'src/index.js',
      interpreter: 'node',
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
}
