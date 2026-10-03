// 隔离的 Electron 界面检查，不访问真实凭据、开发机或 ChatGPT。
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'outputs/remote-project');
app.setPath('userData', path.join(output, 'runtime'));
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const source = `<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body>
    <script type="module">
      import { requestRemoteProject } from '/remote-project-dialog.ts';
      import { setLanguage } from '/i18n.ts';
      window.api = {
        pluginsSnapshot: async () => ({ ok:true, data:{ plugins:[] } }),
        pluginsInstall: async request => ({ok:true,data:{plugins:[{id:'fixture-remote',name:'Development server',source:request.source}]}}),
        addRemoteProject: async (id,path) => new Promise(resolve => { window.captured={id,path}; window.release=()=>resolve({ok:true,data:{id:'fixture-project',path}}); })
      };
      window.begin = locale => { setLanguage(locale); void requestRemoteProject().then(value=>window.accepted=value); };
      window.fixtureReady = true;
    </script></body></html>`;
  const server = await createServer({ configFile:false, root:path.join(root,'src/renderer'), server:{host:'127.0.0.1',port:0},
    plugins:[{name:'remote-project-fixture',configureServer(vite){vite.middlewares.use('/fixture.html',async (_req,res)=>{
      res.setHeader('content-type','text/html');res.end(await vite.transformIndexHtml('/fixture.html',source));
    });}}] });
  let win;
  try {
    await server.listen(); fs.mkdirSync(output,{recursive:true});
    win = new BrowserWindow({show:false,width:1000,height:800,webPreferences:{sandbox:true,backgroundThrottling:false}});
    const js = code => win.webContents.executeJavaScript(code);
    const wait = async code => { for(let i=0;i<100;i++){if(await js(code))return;await new Promise(resolve=>setTimeout(resolve,30));}throw new Error('Fixture did not reach '+code); };
    await win.loadURL(server.resolvedUrls.local[0]+'fixture.html'); await wait('!!window.fixtureReady');
    for(const locale of ['en','zh-CN']) {
      await js(`window.begin(${JSON.stringify(locale)}); true`); await wait('!!document.querySelector("dialog[open]")');
      for(const width of [1000,560]) {
        win.setSize(width,800);
        const geometry = await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{
          const d=document.querySelector('dialog'),r=d.getBoundingClientRect();
          resolve({left:r.left,right:r.right,width:innerWidth,overflow:d.scrollWidth>d.clientWidth+1});
        })))`);
        assert(geometry.left>=0 && geometry.right<=geometry.width && !geometry.overflow,JSON.stringify(geometry));
        fs.writeFileSync(path.join(output,locale+'-'+width+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
      }
      await js(`document.querySelector('input[type=url]').value='http://127.0.0.1:8787/mcp';document.querySelector('input[type=password]').value='fixture-token';
        document.querySelector('input[placeholder="/srv/project"]').value='/srv/project';document.querySelector('form').requestSubmit(); true`);
      await wait('!!window.captured');
      assert.deepEqual(await js('window.captured'),{id:'fixture-remote',path:'/srv/project'});
      assert(await js(`document.querySelector('input[placeholder="/srv/project"]').disabled`));
      assert(!(await js(`document.body.textContent.includes('fixture-token')`)));
      await js('window.release(); true'); await wait('!document.querySelector("dialog")');
      assert.equal((await js('window.accepted')).id,'fixture-project');
      await js('delete window.captured; true');
    }
    console.log(JSON.stringify({remoteProjectDialog:true,locales:['en','zh-CN'],widths:[1000,560],output}));
  } finally { win?.destroy(); await server.close(); }
  app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
