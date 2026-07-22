import type { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Config } from './config';
import type { AisIngestor } from './sources/ais';
import { inBbox, ViewportMsg } from './types';

interface Client { ws: WebSocket; bbox: { latMin: number; lonMin: number; latMax: number; lonMax: number } | null; alive: boolean; }

/**
 * WebSocket hub at /stream. A client sends {type:'viewport', bbox:[minLon,minLat,maxLon,maxLat]};
 * the hub pushes the vessels inside that box on a fixed cadence (snapshot, capped). Simple and
 * robust for v1 — true per-vessel deltas can come later.
 */
export class StreamHub {
  private wss: WebSocketServer;
  private clients = new Set<Client>();

  constructor(server: Server, private ais: AisIngestor, private cfg: Config) {
    this.wss = new WebSocketServer({ server, path: '/stream' });

    this.wss.on('connection', (ws) => {
      const client: Client = { ws, bbox: null, alive: true };
      this.clients.add(client);
      ws.send(JSON.stringify({ type: 'hello', ais: this.ais.status() }));

      ws.on('message', (data) => {
        let msg: any;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg && msg.type === 'viewport' && Array.isArray(msg.bbox) && msg.bbox.length === 4) {
          const [minLon, minLat, maxLon, maxLat] = (msg as ViewportMsg).bbox.map(Number);
          if ([minLon, minLat, maxLon, maxLat].every(Number.isFinite)) {
            client.bbox = { latMin: Math.min(minLat, maxLat), lonMin: Math.min(minLon, maxLon), latMax: Math.max(minLat, maxLat), lonMax: Math.max(minLon, maxLon) };
            this.sendVessels(client); // immediate response so the map fills without waiting a tick
          }
        }
      });

      ws.on('pong', () => { client.alive = true; });
      ws.on('close', () => this.clients.delete(client));
      ws.on('error', () => this.clients.delete(client));
    });

    setInterval(() => this.tick(), this.cfg.streamIntervalMs);
    // keepalive: drop dead sockets
    setInterval(() => {
      for (const c of this.clients) {
        if (!c.alive) { try { c.ws.terminate(); } catch {} this.clients.delete(c); continue; }
        c.alive = false; try { c.ws.ping(); } catch {}
      }
    }, 30_000);
  }

  private tick(): void {
    for (const c of this.clients) this.sendVessels(c);
  }

  private sendVessels(c: Client): void {
    if (c.ws.readyState !== WebSocket.OPEN || !c.bbox) return;
    const box = c.bbox;
    const all = this.ais.all();
    const inView = [];
    for (const v of all) {
      if (inBbox(v, box)) { inView.push(v); if (inView.length >= this.cfg.maxVesselsPerClient) break; }
    }
    const payload = JSON.stringify({ type: 'ships', full: true, count: inView.length, vessels: inView });
    try { c.ws.send(payload); } catch {}
  }

  clientCount(): number { return this.clients.size; }
}
