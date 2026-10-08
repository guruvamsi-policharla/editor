/** The `agentReview.trace` setting: the controller and the edit logs report what they decide. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MultiRootReview } from '@editor/engine';
import { ReviewController } from '../src/controller';
import { EditLogs } from '../src/editLog';

describe('trace', () => {
  it('pushes, review actions and edit-log restarts are traced; the engine traces through the same function', async () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-review-trace-')));
    const root = path.join(tmp, 'ws');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
    const lines: string[] = [];
    const trace = (m: string) => lines.push(m);
    const review = await MultiRootReview.open({ roots: [root], storageBase: path.join(tmp, 'store'), git: false, trace });
    const core = { setBaseline: async () => {}, remove: async () => {} };
    const ctl = new ReviewController(review, core, { isDirty: () => false }, { info() {}, warn() {}, error() {}, trace });
    const abs = path.join(root, 'a.txt');
    fs.writeFileSync(abs, 'two\n');
    await ctl.handleFsEvents([abs]);
    await ctl.idle();
    await ctl.onReviewAction({ kind: 'acceptFile', path: abs });
    await ctl.idle();
    const logs = new EditLogs();
    logs.trace = trace;
    logs.markClean('k', 'x', 'opened');
    logs.onChange('k', [{ rangeOffset: 0, rangeLength: 0, text: 'y' }], false, 2, 'yx');
    const text = lines.join('\n');
    expect(text).toContain('a.txt: pending');
    expect(text).toContain(`${abs}: baseline pushed to the editor (external)`);
    expect(text).toContain(`${abs}: review action acceptFile`);
    expect(text).toContain('(Keep file)');
    expect(text).toContain(`${abs}: removed from the editor's review`);
    expect(text).toContain('edit log of k restarts (opened)');
    await review.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
