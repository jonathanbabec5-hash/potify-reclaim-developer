import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GET} from '../app/reclaim/route.ts';
test('the launch CTA opens only the existing official Reclaim service',()=>{const r=GET(new Request('https://launch.example/reclaim?from=hero'));assert.equal(r.status,302);const u=new URL(r.headers.get('Location'));assert.equal(u.origin,'https://potify-project-reclaim.replit.app');assert.equal(u.searchParams.get('utm_campaign'),'reclaim_early_access');assert.equal(u.searchParams.get('utm_content'),'hero');});
test('untrusted placement values cannot change the destination',()=>{const r=GET(new Request('https://launch.example/reclaim?from=https://example.com'));const u=new URL(r.headers.get('Location'));assert.equal(u.origin,'https://potify-project-reclaim.replit.app');assert.equal(u.searchParams.get('utm_content'),'hero');});
