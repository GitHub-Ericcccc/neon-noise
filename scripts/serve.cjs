// Local-only preview. Private plans, recordings, artifacts and .git are never served.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..');
const files=new Set(['index.html','impact-core.js','impact-worklet.js','record-files.js','record-logging.js','LICENSE','README.md','.nojekyll','experiments/record-logging/index.html']);
const port=Number(process.argv[2]||8765);
http.createServer((req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname;
 if(pathname==='/experiments/record-logging'){res.writeHead(302,{Location:'/experiments/record-logging/'}).end();return;}
 const name=pathname==='/experiments/record-logging/'?'experiments/record-logging/index.html':pathname.slice(1)||'index.html';
 if(!files.has(name)){res.writeHead(404).end();return;}
 res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript; charset=utf-8':name.endsWith('.html')?'text/html; charset=utf-8':'text/plain; charset=utf-8');
 res.setHeader('Cache-Control','no-store');
 fs.createReadStream(path.join(root,name)).on('error',()=>res.writeHead(500).end()).pipe(res);
}).listen(port,'127.0.0.1',()=>console.log(`Preview: http://127.0.0.1:${port}/`));
