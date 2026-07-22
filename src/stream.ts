import type { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Config } from './config';
import type { AisIngestor } from './sources/ais';
import type { OpenSkyIngestor } from './sources/opensky';
import { inBbox, ViewportMsg } from './types';

interface Box { latMin: number; lonMin: number; latMax: number; lonMax: number; }
interface Client { ws: WebSocket; bbox: Box | null; want: Set<string>; alive: boolean; }

export interface Sources { ais: AisIngestor; opensky: OpenSkyIngestor; }

/**
 * WebSocket hub at /stream. A client sends
 *   {type:'viewport', bbox:[minLon,minLat,maxLon,maxLat], want?:['ships','aircraft']}
 * and the hub pushes the ships and/or aircraft inside that box on a fixed cadence
 * (snapshot, capped). `want` lets a client ask for only the layers it has switched on.
 */
export class StreamHub {
  private wss: WebSocketServer;
  private clients = new Set<Client>();

  constructor(server: Server, private src: Sources, private cfg: Config) {
    this.wss = new WebSocketServer({ server, path: '/stream' });

    this.wss.on('connection', (ws) => {
      const client: Client = { ws, bbox: null, want: new Set(['ships', 'aircraft']), alive: true };
      this.clients.add(client);
      ws.send(JSON.stringify({ type: 'hello', ais: this.src.ais.status(), opensky: this.src.opensky.status() }));

      ws.on('message', (data) => {
        let msg: any;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg && msg.type === 'viewport' && Array.isArray(msg.bbox) && msg.bbox.length === 4) {
          const [minLon, minLat, maxLon, maxLat] = (msg as ViewportMsg).bbox.map(Number);
          if ([minLon, minLat, maxLon, maxLat].every(Number.isFinite)) {
            client.bbox = { latMin: Math.min(minLat, maxLat), lonMin: Math.min(minLon, maxLon), latMax: Math.max(minLat, maxLat), lonMax: Math.max(minLon, maxLon) };
          }
          if (Array.isArray(msg.want)) client.want = new Set(msg.want.map(String));
          this.sendData(client); // immediate response so the map fills without waiting a tick
        }
      });

      ws.on('pong', () => { client.alive = true; });
      ws.on('close', () => this.clients.delete(client));
      ws.on('error', () => this.clients.delete(client));
    });

    setInterval(() => { for (const c of this.clients) this.sendData(c); }, this.cfg.streamIntervalMs);
    setInterval(() => {
      for (const c of this.clients) {
        if (!c.alive) { try { c.ws.terminate(); } catch {} this.clients.delete(c); continue; }
        c.alive = false; try { c.ws.ping(); } catch {}
      }
    }, 30_000);
  }

  private sendData(c: Client): void {
    if (c.ws.readyState !== WebSocket.OPEN || !c.bbox) return;
    const box = c.bbox;

    if (c.want.has('ships')) {
      const inView = [];
      for (const v of this.src.ais.all()) {
        if (inBbox(v, box)) { inView.push(v); if (inView.length >= this.cfg.maxVesselsPerClient) break; }
      }
      try { c.ws.send(JSON.stringify({ type: 'ships', count: inView.length, vessels: inView })); } catch {}
    }

    if (c.want.has('aircraft')) {
      const inView = [];
      for (const a of this.src.opensky.all()) {
        if (inBbox(a, box)) { inView.push(a); if (inView.length >= this.cfg.maxAircraftPerClient) break; }
      }
      try { c.ws.send(JSON.stringify({ type: 'aircraft', count: inView.length, craft: inView })); } catch {}
    }
  }

  clientCount(): number { return this.clients.size; }
}
