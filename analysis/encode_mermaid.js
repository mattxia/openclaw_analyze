const { deflateSync } = require('zlib');
const fs = require('fs');

const code = fs.readFileSync('C:/Users/xiabin/lobsterai/project/diagram.mmd', 'utf8').trim();
const json = JSON.stringify({ code: code, mermaid: { theme: 'default' } });
const compressed = deflateSync(Buffer.from(json, 'utf8'));
const base64 = compressed.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
fs.writeFileSync('C:/Users/xiabin/lobsterai/project/diagram_url.txt', 'https://mermaid.ink/img/pako:' + base64);
console.log('URL written, length:', base64.length);
