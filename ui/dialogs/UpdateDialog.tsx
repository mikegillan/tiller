import { send } from '../conn';
import { Modal } from '../controls/Modal';
import { Icon } from '../controls/icons';
import { ReleaseNotes } from '../release-notes/ReleaseNotes';
import { openDialog, useStore } from '../store';
import './update-dialog.css';

const close = () => openDialog(null);

function UpdateIcon({ name }: { name: 'warning' | 'lock' | 'document' | 'spinner' | 'arrow' }) {
  const paths = {
    warning: 'M12 3L2 21h20L12 3zM12 9v5M12 17v.1',
    lock: 'M7 10V7a5 5 0 0110 0v3M5 10h14v11H5z',
    document: 'M6 2h8l5 5v15H6zM14 2v6h5M9 12h7M9 16h5',
    spinner: 'M20 12a8 8 0 11-8-8',
    arrow: 'M4 12h16M14 6l6 6-6 6',
  };
  return <svg className={name === 'spinner' ? 'update-spinner' : undefined} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

export function UpdateDialog() {
  const upd = useStore((s) => s.update);
  const runtimeBehindCheckout = !!upd?.runtimeSha && upd.runtimeSha !== upd.sha;
  const available = !!upd?.target && upd.sha !== upd.target.sha;
  const restartOnly = !!upd?.target && runtimeBehindCheckout && upd.sha === upd.target.sha && upd.currentVersion === upd.target.tag;
  const actionable = available || restartOnly;
  const blocked = actionable && !upd?.eligible && !upd?.applying && !upd?.checking;
  const busy = !!upd?.checking || !!upd?.applying;
  const releases = upd?.releases.length ? upd.releases : upd?.target ? [upd.target] : [];
  const title = upd?.applying ? 'Installing update' : restartOnly ? 'Restart required' : available ? 'Update available' : 'Tiller releases';
  const subtitle = upd?.applying ? 'Building and restarting Tiller. This may take a few minutes.'
    : upd?.checking ? 'Checking for the latest stable release and update eligibility.'
    : restartOnly ? 'Rebuild the current release to finish updating the running daemon.'
    : available ? `Tiller ${upd?.target?.tag}${blocked ? ' is available. Resolve the blocker below to continue.' : ' is ready to install.'}`
    : upd?.target && !runtimeBehindCheckout && !upd.fetchError ? 'Your checkout is at the latest stable release.'
    : 'Check for the latest stable Tiller release.';
  return <Modal title={title} className="modal update-dialog" resizable restoreFocus onClose={close} footer={<>
    {actionable && <p className="update-interruption">Updating will suspend running agents when Tiller restarts. Their sessions are kept so they can be resumed.</p>}
    <div className="btns update-actions">
      <button className="btn update-later" autoFocus onClick={close}>Later</button>
      <button className={`btn${blocked || !actionable ? ' primary' : ''}`} disabled={busy} onClick={() => send({ t: 'updateCheck' })}>
        {upd?.checking && !upd.applying && <UpdateIcon name="spinner" />}{upd?.checking && !upd.applying ? 'Checking…' : 'Check again'}
      </button>
      {actionable && <button className={`btn${blocked ? '' : ' primary'}`} aria-describedby={blocked ? 'update-blocked-reason' : undefined} disabled={!upd?.eligible || busy} onClick={() => send({ t: 'update', tag: upd!.target!.tag, sha: upd!.target!.sha })}>
        {upd?.applying ? <UpdateIcon name="spinner" /> : blocked ? <UpdateIcon name="lock" /> : null}
        {upd?.applying ? 'Installing…' : restartOnly ? 'Rebuild and restart' : `Update ${upd?.target?.tag}`}
      </button>}
    </div>
  </>}>
    <p className="update-subtitle">{subtitle}</p>
    <div className="update-versions">
      <span className="update-version-pair"><span>Current checkout</span><strong>{upd?.currentVersion || 'Source'}</strong></span>
      {upd?.target && <><UpdateIcon name="arrow" /><span className="update-version-pair"><span>{available ? 'Available' : 'Latest stable'}</span><strong>{upd.target.tag}</strong></span></>}
    </div>
    {upd?.sha && <p className="update-checkout">Checkout <code>{upd.sha.slice(0, 7)}</code></p>}
    {runtimeBehindCheckout && <p>The source checkout has moved to {upd?.sha.slice(0, 7)}, while this daemon is running {upd?.runtimeSha?.slice(0, 7)}.</p>}
    {blocked && <section className="update-blocker" id="update-blocked-reason" role="status">
      <UpdateIcon name="warning" />
      <div><h3>{upd?.blocker === 'dirty' ? 'Save your changes to continue' : 'Update blocked'}</h3>
        <p>{upd?.blocker === 'dirty' ? 'The main checkout has uncommitted or untracked files.' : upd?.reason || 'Check again to find out why this update is unavailable.'}</p>
        {upd?.blocker === 'dirty' && <ol><li>Move changes to a task worktree, or stash them, including untracked files.</li><li>Check again to enable the update.</li></ol>}
      </div>
    </section>}
    {upd?.reason && !blocked && !upd.checking && <p>{upd.reason}</p>}
    {upd?.fetchError && <p className="update-error" role="alert">{upd.fetchError}</p>}
    {upd?.failed && <p className="update-error" role="alert">{upd.failed}</p>}
    <p className="update-progress" role="status" aria-live="polite">{busy && <><UpdateIcon name="spinner" />{upd?.applying ? 'Installing update…' : 'Checking for updates…'}</>}</p>
    {releases.length > 0 && <section className="update-notes" aria-label="Available release notes">
      <h3>{releases.length === 1 ? `What’s new in ${releases[0].tag}` : 'What’s new'}</h3>
      {releases.map((release) => <section key={release.id}>
        {releases.length > 1 && <h4>{release.tag}{release.name !== release.tag && ` · ${release.name}`}</h4>}
        {releases.length === 1 && release.name !== release.tag && <h4>{release.name}</h4>}
        <ReleaseNotes body={release.body} />
      </section>)}
    </section>}
    {actionable && <details className="update-installation"><summary><UpdateIcon name="document" /><span>Installation details</span><Icon name="chevron" /></summary>
      <p>{restartOnly ? 'Rebuild affected packages, UI and app from the current release, then restart the daemon.' : 'Install this release in the clean main checkout, rebuild changed packages, UI and app, then restart the daemon.'} If the app is rebuilt, quit and reopen Tiller.</p>
      <p>Automatic resumption follows your resume-on-start setting and idle-age limit. Resuming a session also requires its transcript and workspace to remain available.</p>
    </details>}
  </Modal>;
}
