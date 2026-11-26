import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { inspectWallet, InvalidWalletError, type Scanner } from './inspection.ts';

function summaryOnly(data: Awaited<ReturnType<typeof inspectWallet>>) {
  const {shownCandidates: _details, omittedCandidateCount: _count, ...summary} = data;
  return {...summary, candidateDetailsIncluded:false, candidateDetailsOmitted:data.candidateCount};
}

export function createApp(scan: Scanner, options: {premiumGate?: express.RequestHandler; paymentMode?: 'disabled'|'devnet'} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use(express.json({limit: '8kb'}));
  // This local, per-process limit is not a substitute for a public edge rate limit.
  const requests = new Map<string, {count: number; until: number}>();
  app.use((req, res, next) => {
    if (req.path === '/health') return next();
    const now = Date.now();
    if (requests.size > 10000) for (const [key, item] of requests) if (item.until <= now) requests.delete(key);
    const key = req.socket.remoteAddress || 'unknown';
    const item = requests.get(key);
    const bucket = !item || item.until <= now ? {count:0, until:now+60000} : item;
    bucket.count++;
    requests.set(key, bucket);
    if (bucket.count > 30) return res.status(429).json({error:'Rate limit exceeded. Try again later.'});
    next();
  });
  app.get('/health', (_req, res) => res.json({status:'ok', service:'potify-roots-agent-gateway', payments:options.paymentMode || 'disabled'}));
  app.post('/api/v1/reclaim-preview', async (req, res) => {
    try { return res.json(summaryOnly(await inspectWallet(req.body?.wallet, scan))); }
    catch (error) {
      if (error instanceof InvalidWalletError) return res.status(400).json({error:'Enter a valid Solana public address.'});
      return res.status(503).json({error:'The source is temporarily unavailable. Try again later.'});
    }
  });
  app.post('/api/v1/reclaim-details', async (req, res, next) => {
    if (!options.premiumGate) return res.status(503).json({error:'Paid previews are disabled.'});
    try {
      // Resolve the read before any settlement: invalid input or RPC errors cannot be charged.
      res.locals.preview = await inspectWallet(req.body?.wallet, scan);
      next();
    } catch (error) {
      if (error instanceof InvalidWalletError) return res.status(400).json({error:'Enter a valid Solana public address.'});
      return res.status(503).json({error:'The source is temporarily unavailable. Try again later.'});
    }
  }, (req, res, next) => options.premiumGate!(req, res, next), (_req, res) => res.json(res.locals.preview));
  app.post('/mcp', async (req, res) => {
    const server = new McpServer({name:'potify-roots-agent-gateway', version:'0.1.0'});
    server.registerTool('potify_reclaim_preview', {
      description:'Read-only Solana token-account rent candidates from POTIFY Project Reclaim. Reports gross lamports before fees, never signs or moves funds.',
      inputSchema:{wallet:z.string().min(32).max(44).describe('Solana public wallet address; never a private key')},
      annotations:{readOnlyHint:true, destructiveHint:false, openWorldHint:true},
    }, async ({wallet}) => {
      try {
        const data = summaryOnly(await inspectWallet(wallet, scan));
        return {content:[{type:'text', text:JSON.stringify(data)}], structuredContent:data};
      } catch (error) {
        return {isError:true, content:[{type:'text', text:error instanceof InvalidWalletError
          ? 'Enter a valid Solana public address.' : 'The source is temporarily unavailable. Try again later.'}]};
      }
    });
    const transport = new StreamableHTTPServerTransport({sessionIdGenerator:undefined, enableJsonResponse:true});
    res.on('close', () => { void transport.close(); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch { if (!res.headersSent) res.status(500).json({error:'MCP request failed.'}); }
  });
  app.all('/mcp', (_req, res) => res.status(405).json({error:'Use POST for this stateless MCP server.'}));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error?.status === 413 ? 413 : 400).json({error:'Invalid request body.'});
  });
  return app;
}
