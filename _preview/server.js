'use strict';
// Tiny static server for previewing the board. Serves ../renderer, default board.html.
const http=require('http'), fs=require('fs'), path=require('path');
const root=path.join(__dirname,'..','renderer');
const port=Number(process.env.PORT||8799);
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'};
http.createServer((req,res)=>{
  let p=decodeURIComponent((req.url||'/').split('?')[0]);
  if(p==='/'||p==='') p='/board.html';
  const fp=path.join(root,p);
  if(!fp.startsWith(root)){ res.writeHead(403); return res.end('no'); }
  fs.readFile(fp,(e,buf)=>{
    if(e){ res.writeHead(404); return res.end('not found'); }
    res.writeHead(200,{'Content-Type':types[path.extname(fp)]||'application/octet-stream'});
    res.end(buf);
  });
}).listen(port,()=>console.log('preview on http://localhost:'+port));
