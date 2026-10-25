import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

async function freePort(){const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as {port:number}).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}
async function main(){
  const port=await freePort();
  const base=`http://127.0.0.1:${port}`;
  const directory=mkdtempSync(join(tmpdir(),'peer-browser-'));
  const child=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{cwd:process.cwd(),env:{...process.env,DATABASE_URL:'',P2P_DB_PATH:join(directory,'app.sqlite'),NEXT_TELEMETRY_DISABLED:'1'},stdio:'ignore'});
  try {
    let ready=false;
    for(let attempt=0;attempt<100;attempt++){try{const response=await fetch(base);if(response.ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
    assert.ok(ready,'web server did not start');
    const browser=await chromium.launch({executablePath:process.env.P2P_CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
    try{
      const page=await browser.newPage();
      await page.goto(base);
      await page.locator('nav a').first().waitFor();
      assert.deepEqual(await page.locator('nav a').allTextContents(),['P2P 마켓','광고등록']);
      assert.equal(await page.getByText('지갑 로그인').count(),0);
      await page.locator('.language-select').selectOption('en');
      assert.deepEqual(await page.locator('nav a').allTextContents(),['P2P Market','Post Ad']);
      await page.getByRole('link',{name:'Sign up'}).click();
      assert.equal(await page.locator('input[type=email][required]').count(),1);
      assert.equal(await page.locator('input[type=tel][required]').count(),1);
      assert.ok(await page.locator('select option').count()>200);
      await page.locator('html[lang=en]').waitFor();
    }finally{await browser.close();}
    console.log('PASS: logged-out GNB, Korean/English switch, required email and country-code phone fields.');
  }finally{child.kill('SIGTERM');rmSync(directory,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
