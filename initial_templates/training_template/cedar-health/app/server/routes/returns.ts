import type { Application, Request, Response } from 'express';
import express from 'express';
import type { AppDb } from '../db/index.js';

/**
 * Care actions routes — patient queue, detail, and assignment endpoints.
 * Drives the Care Coordinator page.
 *
 * TODO: Adapt from the template's returns routes to Cedar Health care-actions model.
 * Implement with queries from server/db/queries/carecoordination.ts
 */


export function registerReturnsRoutes(
  app: Application,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _deps: { db: AppDb },
): void {
  const r = express.Router();

  // TODO: GET /api/returns — patient queue with filtering
  r.get('/', async (_req: Request, res: Response) => {
    // Stub for now
    res.json([]);
  });

  // TODO: GET /api/returns/:id — care-action detail
  r.get('/:id', async (_req: Request, res: Response) => {
    // Stub for now
    res.json({});
  });

  // TODO: POST /api/returns/:id/decide — assign/complete care action
  r.post('/:id/decide', async (_req: Request, res: Response) => {
    // Stub for now
    res.json({ ok: true });
  });

  app.use('/api/returns', r);
}
