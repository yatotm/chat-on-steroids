// 从真实首启页面验证远程入口；不访问用户配置或真实开发机。
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require('./fixtures/app-defaults.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'outputs/remote-project-setup');
app.setPath('userData', path.join(output, 'runtime'));
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const fixture = `
    localStorage.clear();
    localStorage.setItem('cos.ui.language', new URL(location.href).searchParams.get('language') || 'en');
    ${fixtureConfigSource()}
    const state = {config:fixtureConfig({}),hasApiKey:false,hasGoalKey:false,hasRemoteProjects:false,
      resolvedBinary:null,bundledTunnelVersion:null,
      status:{state:'disconnected',detail:'',publicUrl:null,localUrl:null,handshakeAt:null,lastRequestAt:null,lastToolCallAt:null,health:null,surfaces:[]},
      bridge:{running:false,port:0,paired:false,present:false,lastSeenAt:null,extensionVersion:null},
      update:{current:'2.2.1',latest:null,stage:'idle',error:null,checkedAt:null}};
    const plugins = {plugins:[],catalog:[],schemaRevision:0}, projects = [];
    const ok = data => Promise.resolve({ok:true,data:structuredClone(data)});
    let stateListener = () => {};
    window.calls = {local:0,install:0,remote:[]}; window.rejectRemote = true; window.errors = [];
    window.addEventListener('error', event => window.errors.push(event.message));
    window.addEventListener('unhandledrejection', event => window.errors.push(String(event.reason)));
    window.api = new Proxy({
      getState:()=>ok(state), getLog:()=>ok([]), onStateChanged:fn=>{stateListener=fn;return ()=>{};},
      listProjects:()=>ok(projects), listSessions:()=>ok({sessions:[],total:0,nextCursor:null,activeId:null,pressure:[],blocked:[]}),
      getSwarm:()=>ok({running:false,runId:null,agents:[],maxWorkers:2,pendingReports:0}),
      getChatModels:()=>ok({state:'unknown',models:[]}), pluginsSnapshot:()=>ok(plugins),
      pluginsInstall:request=>{window.calls.install++;plugins.plugins.push({id:'fixture-remote',name:'Development server',
        source:request.source,enabled:true,status:'ready',tools:[]});return ok(plugins);},
      addRemoteProject:(pluginId,directory)=>{
        window.calls.remote.push({pluginId,directory});
        if(window.rejectRemote) return Promise.resolve({ok:false,error:'Project not allowed'});
        const project = {id:'fixture-project',name:'Server project',path:directory,createdAt:1,
          remote:{pluginId,workspaceId:'fixture-workspace',endpointId:'fixture-endpoint'}};
        projects.push(project);state.hasRemoteProjects=true;stateListener(structuredClone(state));return ok(project);
      },
      addRoot:()=>{window.calls.local++;state.config.roots=[{name:'local-project',path:'/local-project'}];return ok(state);}
    },{get:(target,key)=>key in target?target[key]:()=>ok(null)});
    await import('/main.ts');
    const still=document.createElement('style');still.textContent='*,*::before,*::after{animation:none!important;transition:none!important}';document.head.append(still);
    window.fixtureReady=true;
  `;
  const server = await createServer({configFile:false,root:path.join(root,'src/renderer'),server:{host:'127.0.0.1',port:0},
    plugins:[{name:'remote-setup-fixture',configureServer(vite){vite.middlewares.use('/fixture.html',async (_req,res)=>{
      const source=fs.readFileSync(path.join(root,'src/renderer/index.html'),'utf8')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace('</body>','<script type="module">'+fixture+'</script></body>');
      res.setHeader('content-type','text/html');res.end(await vite.transformIndexHtml('/fixture.html',source));
    });}}]});
  let win;
  try {
    await server.listen();fs.mkdirSync(output,{recursive:true});
    win=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{sandbox:true,backgroundThrottling:false}});
    const js=code=>win.webContents.executeJavaScript(code);
    const wait=async code=>{for(let i=0;i<200;i++){if(await js(code))return;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('Fixture did not reach '+code);};
    const screenshot=async name=>{
      await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
      await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    };
    for(const locale of ['en','zh-CN']) {
      await win.loadURL(server.resolvedUrls.local[0]+'fixture.html?language='+locale);
      await wait('!!window.fixtureReady && document.querySelector("[data-panel=setup]").classList.contains("is-active")');
      assert.equal(await js('document.getElementById("setupProgress").getAttribute("aria-valuenow")'),'0');
      assert(await js('document.getElementById("wizAddRemoteProject").checkVisibility()'));
      assert(!(await js('document.getElementById("addRemoteProject").checkVisibility()')));
      if(locale==='zh-CN') assert.equal(await js('document.getElementById("wizAddRemoteProject").textContent.trim()'),'连接 Linux 开发机');
      for(const width of [1100,800]) {
        win.setSize(width,900);
        await js('document.getElementById("wizAddRemoteProject").scrollIntoView({block:"center"})');
        const geometry=await js('new Promise(resolve=>requestAnimationFrame(()=>{const b=document.getElementById("wizAddRemoteProject"),r=b.getBoundingClientRect();resolve({left:r.left,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight})}))');
        assert(geometry.left>=0 && geometry.right<=geometry.width && geometry.bottom<=geometry.height,JSON.stringify(geometry));
        await screenshot(locale+'-first-run-'+width+'.png');
      }
      await js('document.getElementById("wizAddRemoteProject").click();true');
      await wait('!!document.querySelector(".remote-project-dialog[open]")');
      await js('document.querySelector(".remote-project-dialog button[type=button]").click();true');
      await wait('!document.getElementById("wizAddRemoteProject").disabled');
      assert.equal(await js('document.getElementById("setupProgress").getAttribute("aria-valuenow")'),'0');
      await js('document.getElementById("wizAddRemoteProject").click();true');
      await wait('!!document.querySelector(".remote-project-dialog[open]")');
      await js(`document.querySelector('.remote-project-dialog input[type=url]').value='http://127.0.0.1:8787/mcp';
        document.querySelector('.remote-project-dialog input[placeholder="/srv/project"]').value='/srv/project';
        document.querySelector('.remote-project-dialog form').requestSubmit();true`);
      await wait('document.querySelector(".remote-project-status").textContent === "Project not allowed"');
      assert(!(await js('document.querySelector("[data-step=folder]").classList.contains("is-done")')));
      assert.equal(await js('window.calls.local'),0);
      await js('window.rejectRemote=false;document.querySelector(".remote-project-dialog form").requestSubmit();true');
      await wait('!document.querySelector(".remote-project-dialog")');
      assert(await js('document.querySelector("[data-panel=setup]").classList.contains("is-active")'));
      assert(await js('document.querySelector("[data-step=folder]").classList.contains("is-done")'));
      assert.equal(await js('document.getElementById("wizFolders").textContent'),locale==='zh-CN'?'已添加远程项目':'Remote project added');
      assert.equal(await js('document.getElementById("setupProgress").getAttribute("aria-valuenow")'),'1');
      assert.deepEqual(await js('window.calls'),{local:0,install:1,remote:[
        {pluginId:'fixture-remote',directory:'/srv/project'},{pluginId:'fixture-remote',directory:'/srv/project'}]});
      await screenshot(locale+'-remote-added.png');
      await js('document.getElementById("wizOpenPlugins").click();true');
      assert(await js('document.querySelector("[data-panel=plugins]").classList.contains("is-active")'));
      await js('document.getElementById("newChat").click();true');
      assert.equal(await js('document.querySelector(".project-name").textContent'),'Server project');
      await js('document.getElementById("addRemoteProject").click();true');
      await wait('!!document.querySelector(".remote-project-dialog[open]")');
      await js('document.querySelector(".remote-project-dialog button[type=button]").click();true');
      assert.deepEqual((await js('window.errors')).filter(error=>!BENIGN_RENDERER_ERRORS.includes(error)),[]);
    }
    await win.loadURL(server.resolvedUrls.local[0]+'fixture.html?language=zh-CN');
    await wait('!!window.fixtureReady && document.querySelector("[data-panel=setup]").classList.contains("is-active")');
    await js('document.getElementById("wizAddFolder").click();true');
    await wait('document.querySelector("[data-step=folder]").classList.contains("is-done")');
    assert.equal(await js('document.getElementById("wizFolders").textContent'),'/local-project');
    assert.deepEqual(await js('window.calls'),{local:1,install:0,remote:[]});
    console.log(JSON.stringify({firstRunRemoteSetup:true,locales:['en','zh-CN'],widths:[1100,800],cancelAndFailureStayIncomplete:true,localFolderStillWorks:true,output}));
  } finally {win?.destroy();await server.close();}
  app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
