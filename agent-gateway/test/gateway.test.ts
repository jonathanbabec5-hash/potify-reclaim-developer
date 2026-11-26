import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.ts';
import { inspectWallet, InvalidWalletError, type Candidate } from '../src/inspection.ts';

const wallet = '11111111111111111111111111111111';
const accounts: Candidate[] = [
  {pubkey:'account-1', mint:'mint-1', program:'SPL', lamports:1488440n, closeEligible:true},
  {pubkey:'account-2', mint:'mint-2', program:'Token-2022', lamports:1600000n, closeEligible:false, unsupportedReason:'Frozen'},
  {pubkey:'account-3', mint:'mint-3', program:'Token-2022', lamports:1513840n, closeEligible:true},
];
const fakeScan = async () => accounts;
const service = createApp(fakeScan).listen(0, '127.0.0.1');
await new Promise<void>(resolve => service.once('listening', resolve));
const port = (service.address() as {port:number}).port;
const origin = `http://127.0.0.1:${port}`;
after(() => service.close());

test('reports conservative candidates and gross lamports without claiming a final quote', async () => {
  const result = await inspectWallet(wallet, fakeScan);
  assert.equal(result.totalTokenAccounts, 3);
  assert.equal(result.candidateCount, 2);
  assert.equal(result.estimatedGrossLamports, '3002280');
  assert.deepEqual(result.shownCandidates.map(row => row.account), ['account-1','account-3']);
  assert.match(result.limitations.join(' '), /before service and network fees/);
  await assert.rejects(() => inspectWallet('not-an-address', fakeScan), InvalidWalletError);
});

test('REST rejects invalid addresses and hides upstream error details', async () => {
  const invalid = await fetch(origin+'/api/v1/reclaim-preview', {
    method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({wallet:'bad'}),
  });
  assert.equal(invalid.status, 400);
  const failing = createApp(async()=>{ throw new Error('secret upstream endpoint'); }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => failing.once('listening', resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${(failing.address() as {port:number}).port}/api/v1/reclaim-preview`, {
      method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({wallet}),
    });
    assert.equal(response.status,503);
    assert.doesNotMatch(await response.text(), /secret/);
  } finally { failing.close(); }
});

test('premium detail is unavailable by default and is not returned by the free API', async () => {
  const request = {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({wallet})};
  const free = await (await fetch(origin+'/api/v1/reclaim-preview', request)).json();
  assert.equal(free.candidateCount,2);
  assert.equal(free.shownCandidates,undefined);
  assert.equal(free.candidateDetailsOmitted,2);
  const premium = await fetch(origin+'/api/v1/reclaim-details', request);
  assert.equal(premium.status,503);
  assert.match((await premium.json()).error,/disabled/);
});

test('premium route validates and scans before invoking the payment gate', async () => {
  let gateCalls=0;
  const gate: import('express').RequestHandler = (_req,res,_next) => {gateCalls++; res.status(402).json({error:'payment required'});};
  const paid = createApp(fakeScan,{premiumGate:gate,paymentMode:'devnet'}).listen(0,'127.0.0.1');
  await new Promise<void>(resolve => paid.once('listening', resolve));
  const address=`http://127.0.0.1:${(paid.address() as {port:number}).port}/api/v1/reclaim-details`;
  try {
    const send=(value:string)=>fetch(address,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({wallet:value})});
    assert.equal((await send('invalid')).status,400); assert.equal(gateCalls,0);
    const challenge=await send(wallet); assert.equal(challenge.status,402); assert.equal(gateCalls,1);
    assert.doesNotMatch(await challenge.text(),/account-1/);
  } finally { paid.close(); }
});

test('an MCP client can discover and call the read-only tool', async () => {
  const client = new Client({name:'gateway-test',version:'1.0.0'});
  const transport = new StreamableHTTPClientTransport(new URL(origin+'/mcp'));
  await client.connect(transport);
  try {
    const tools=await client.listTools();
    assert.equal(tools.tools[0].name,'potify_reclaim_preview');
    assert.equal(tools.tools[0].annotations?.readOnlyHint,true);
    const result=await client.callTool({name:'potify_reclaim_preview',arguments:{wallet}});
    assert.equal(result.isError,undefined);
    const body=JSON.parse((result.content as Array<{text:string}>)[0].text);
    assert.equal(body.estimatedGrossLamports,'3002280');
    assert.equal(body.candidateCount,2);
  } finally { await client.close(); }
});
