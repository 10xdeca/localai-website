// localai-xdeca-website dev server: http://localhost:8082
module.exports = {
  apps: [
    {
      name: 'localai-xdeca-website',
      script: 'npm',
      args: 'start -- --port=8082',
      cwd: __dirname,
    },
  ],
};
