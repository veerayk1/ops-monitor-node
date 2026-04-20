import { Router } from 'express';
import { getRun, listRunsForJob } from '../database.js';
import { nextRunFor } from '../scheduler.js';

export const runsRouter = Router();

function parseId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

runsRouter.get('/job/:jobId', (req, res) => {
  const jobId = parseId(req.params.jobId);
  if (!jobId) return res.status(400).json({ error: 'Invalid job ID' });
  const rawLimit = parseInt(String(req.query.limit ?? '50'), 10);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), 1000);
  const runs = listRunsForJob(jobId, limit);
  res.json({ runs, next_run_at: nextRunFor(jobId) });
});

runsRouter.get('/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid run ID' });
  const run = getRun(id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(run);
});
