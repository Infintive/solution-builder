import type { Application, Request, Response } from 'express';
import type { AppDb } from '../db/index.js';

/**
 * Unified activity feed — care action approvals, assignments, completions.
 * Powers the home-page "Recent activity" list.
 *
 * TODO: Implement with queries from server/db/queries/carecoordination.ts
 */
export function registerActivityRoutes(
  app: Application,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _deps: { db: AppDb },
): void {
  app.get('/api/activity/recent', async (_req: Request, res: Response) => {
    // TODO: replace stub with actual query
    const events: unknown[] = [];
    res.json(events);
  });
}
