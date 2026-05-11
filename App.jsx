import React, { useState, useEffect, useMemo } from 'react';
import {
  Trophy, Users, Settings, Lock, Unlock, AlertTriangle, Check, X,
  RefreshCw, Trash2, LogOut, ChevronRight, Crown, Skull, ArrowRight, Edit3
} from 'lucide-react';
import { storageGet, storageSet, storageSubscribe } from './firebase.js';

// ============================================================
// STORAGE
// ============================================================

const KEYS = { CONFIG: 'config', FIELD: 'field', ENTRIES: 'entries' };

const DEFAULT_CONFIG = {
  tournamentName: '',
  adminPin: null,
  locked: false,
  setupComplete: false
};

// ============================================================
// ODDS / PARLAY MATH
// ============================================================

const parseOdds = (str) => {
  const s = String(str).trim();
  const m = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (m) return { num: +m[1], den: +m[2] };
  if (/^\d+$/.test(s)) return { num: +s, den: 1 };
  return null;
};

const oddsDecimal = (o) => (o.num / o.den) + 1;
const formatOdds = (o) => `${o.num}/${o.den}`;
const oddsRatio = (o) => o.num / o.den;

// House rule: combined odds = simple sum of each fractional value (num/den).
// e.g. Scheffler 4/1 + Young 12/1 + DeChambeau 20/1 = 36/1.
const computeCombined = (oddsList) => {
  if (!oddsList.length) return 0;
  return oddsList.reduce((a, o) => a + (o.num / o.den), 0);
};
const formatCombined = (sum) => {
  const rounded = Math.round(sum * 10) / 10;
  const display = rounded % 1 === 0
    ? rounded.toString()
    : rounded.toFixed(1);
  if (rounded >= 1000) return `${Math.round(rounded).toLocaleString()}/1`;
  return `${display}/1`;
};

// Parse a pasted field. Tolerates many delimiters.
// Each non-empty line should contain a name and odds like "Scottie Scheffler 9/2".
const parseFieldList = (text) => {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const players = [];
  for (const line of lines) {
    const m = line.match(/^(.+?)[\s,;\t|]+(\d+\s*\/\s*\d+|\d+)\s*$/);
    if (!m) continue;
    const name = m[1].replace(/[,;\t|]+$/, '').trim();
    const odds = parseOdds(m[2]);
    if (!name || !odds) continue;
    players.push({
      id: `${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${players.length}`,
      name,
      oddsNum: odds.num,
      oddsDen: odds.den,
      status: 'active', // 'active' | 'wd_pre_cut' | 'missed_cut' | 'wd_post_cut'
      scores: {}        // {r1, r2, r3, r4} – score to par
    });
  }
  return players;
};

const sortByOdds = (field) =>
  [...field].sort((a, b) => {
    const ra = oddsRatio({ num: a.oddsNum, den: a.oddsDen });
    const rb = oddsRatio({ num: b.oddsNum, den: b.oddsDen });
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });

// ============================================================
// LEADERBOARD COMPUTATION
// ============================================================

// Walk down odds list from a withdrawn player; return first available
// substitute that's not already on the team and isn't itself pre-cut WD.
const findSubstitute = (withdrawnPlayer, blockedIds, sortedField) => {
  const idx = sortedField.findIndex(p => p.id === withdrawnPlayer.id);
  if (idx === -1) return null;
  for (let j = idx + 1; j < sortedField.length; j++) {
    const cand = sortedField[j];
    if (blockedIds.includes(cand.id)) continue;
    if (cand.status === 'wd_pre_cut') continue;
    return cand;
  }
  return null;
};

const resolveTeam = (pickIds, field) => {
  const sorted = sortByOdds(field);
  const resolved = [];
  for (let i = 0; i < pickIds.length; i++) {
    const origId = pickIds[i];
    const player = field.find(p => p.id === origId);
    if (!player) { resolved.push({ originalId: origId, current: null, substituted: false }); continue; }
    if (player.status === 'wd_pre_cut') {
      const blocked = [
        ...resolved.map(r => r.current?.id).filter(Boolean),
        ...pickIds.slice(i + 1)
      ];
      const sub = findSubstitute(player, blocked, sorted);
      resolved.push({ originalId: origId, original: player, current: sub, substituted: !!sub });
    } else {
      resolved.push({ originalId: origId, current: player, substituted: false });
    }
  }
  return resolved;
};

const computeStanding = (entry, field) => {
  const resolved = resolveTeam(entry.picks, field);
  let eliminated = false;
  let elimReason = '';
  for (const r of resolved) {
    if (!r.current) { eliminated = true; elimReason = 'no available substitute'; break; }
    if (r.current.status === 'missed_cut') { eliminated = true; elimReason = `${r.current.name} missed cut`; break; }
    if (r.current.status === 'wd_post_cut') { eliminated = true; elimReason = `${r.current.name} WD after cut`; break; }
  }
  const rounds = ['r1','r2','r3','r4'];
  const roundTotals = {};
  for (const r of rounds) {
    let sum = 0, complete = true;
    for (const m of resolved) {
      if (!m.current) { complete = false; continue; }
      const s = m.current.scores[r];
      if (typeof s === 'number') sum += s; else complete = false;
    }
    roundTotals[r] = complete ? sum : null;
  }
  let running = 0;
  for (const m of resolved) {
    if (!m.current) continue;
    for (const r of rounds) {
      const s = m.current.scores[r];
      if (typeof s === 'number') running += s;
    }
  }
  const combinedOdds = computeCombined(
    resolved
      .filter(r => r.current)
      .map(r => ({ num: r.current.oddsNum, den: r.current.oddsDen }))
  );
  return {
    entry, resolved, eliminated, elimReason,
    total: running, roundTotals,
    saturdayScore: roundTotals.r3, sundayScore: roundTotals.r4,
    combinedOdds
  };
};

const sortStandings = (s) => [...s].sort((a, b) => {
  if (a.eliminated !== b.eliminated) return a.eliminated ? 1 : -1;
  if (a.total !== b.total) return a.total - b.total;
  const aS = a.sundayScore ?? Infinity;
  const bS = b.sundayScore ?? Infinity;
  if (aS !== bS) return aS - bS;
  return (a.saturdayScore ?? Infinity) - (b.saturdayScore ?? Infinity);
});

const formatToPar = (n) => {
  if (typeof n !== 'number') return '–';
  if (n === 0) return 'E';
  return n > 0 ? `+${n}` : `${n}`;
};

// ============================================================
// MAIN APP
// ============================================================

export default function MajorsPicks() {
  const [tab, setTab] = useState('picks');
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [field, setField] = useState([]);
  const [entries, setEntries] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [adminUnlocked, setAdminUnlocked] = useState(false);

  // Load Google Fonts handled via index.html now — nothing needed here.

  // Subscribe to Firestore documents in real time. Each subscription fires
  // once on initial load (with current value or null) and again on any change.
  useEffect(() => {
    const seen = new Set();
    const markSeen = (key) => {
      seen.add(key);
      if (seen.size === 3) setLoaded(true);
    };

    const unsubConfig = storageSubscribe(KEYS.CONFIG, (val) => {
      setConfig(val || DEFAULT_CONFIG);
      markSeen('config');
    });
    const unsubField = storageSubscribe(KEYS.FIELD, (val) => {
      setField(val || []);
      markSeen('field');
    });
    const unsubEntries = storageSubscribe(KEYS.ENTRIES, (val) => {
      setEntries(val || []);
      markSeen('entries');
    });

    return () => {
      unsubConfig();
      unsubField();
      unsubEntries();
    };
  }, []);

  const saveConfig = async (c) => { setConfig(c); await storageSet(KEYS.CONFIG, c); };
  const saveField = async (f) => { setField(f); await storageSet(KEYS.FIELD, f); };
  const saveEntries = async (e) => { setEntries(e); await storageSet(KEYS.ENTRIES, e); };

  const standings = useMemo(
    () => sortStandings(entries.map(e => computeStanding(e, field))),
    [entries, field]
  );

  if (!loaded) {
    return (
      <div style={styles.shell}>
        <div style={{ ...styles.center, height: '100vh' }}>
          <div style={{ fontFamily: 'Fraunces, serif', fontSize: 14, opacity: 0.5 }}>Loading…</div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.shell}>
      <style>{globalCSS}</style>
      <div style={styles.container}>
        <Header config={config} />
        <Tabs tab={tab} setTab={setTab} />
        <div style={styles.content}>
          {tab === 'picks' && (
            <PicksView
              config={config} field={field} entries={entries}
              onSubmit={async (entry) => await saveEntries([...entries, entry])}
              onUpdate={async (id, updates) => await saveEntries(
                entries.map(e => e.id === id
                  ? { ...e, ...updates, editedAt: new Date().toISOString() }
                  : e
                )
              )}
            />
          )}
          {tab === 'leaderboard' && (
            <LeaderboardView standings={standings} field={field} config={config} />
          )}
          {tab === 'admin' && (
            <AdminView
              config={config} field={field} entries={entries}
              unlocked={adminUnlocked} setUnlocked={setAdminUnlocked}
              saveConfig={saveConfig} saveField={saveField} saveEntries={saveEntries}
            />
          )}
        </div>
        <Footer />
      </div>
    </div>
  );
}

// ============================================================
// HEADER + TABS
// ============================================================

const Header = ({ config }) => (
  <header style={styles.header}>
    <div style={styles.headerTop}>
      <div style={styles.flag}>♣</div>
      <div style={{ flex: 1 }}>
        <div style={styles.eyebrow}>The Majors Sweepstake</div>
        <h1 style={styles.title}>
          {config.tournamentName || 'Awaiting Tournament'}
        </h1>
      </div>
      {config.locked && (
        <div style={styles.lockBadge}><Lock size={11} /> Entries closed</div>
      )}
    </div>
  </header>
);

const Tabs = ({ tab, setTab }) => {
  const tabs = [
    { id: 'picks', label: 'Make Picks', icon: <Users size={14} /> },
    { id: 'leaderboard', label: 'Leaderboard', icon: <Trophy size={14} /> },
    { id: 'admin', label: 'Admin', icon: <Settings size={14} /> }
  ];
  return (
    <nav style={styles.tabs}>
      {tabs.map(t => (
        <button
          key={t.id}
          onClick={() => setTab(t.id)}
          style={{ ...styles.tab, ...(tab === t.id ? styles.tabActive : {}) }}
        >
          {t.icon}
          <span>{t.label}</span>
        </button>
      ))}
    </nav>
  );
};

const Footer = () => (
  <footer style={styles.footer}>
    Lowest combined score wins · All three must make the cut · £10 entry
  </footer>
);

// ============================================================
// PICKS VIEW
// ============================================================

function PicksView({ config, field, entries, onSubmit, onUpdate }) {
  const [name, setName] = useState('');
  const [pick1, setPick1] = useState('');
  const [pick2, setPick2] = useState('');
  const [pick3, setPick3] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState(null);

  const sortedField = useMemo(() => sortByOdds(field), [field]);

  const handleEdit = (entry) => {
    setEditingId(entry.id);
    setName(entry.name);
    setPick1(entry.picks[0] || '');
    setPick2(entry.picks[1] || '');
    setPick3(entry.picks[2] || '');
    setError('');
    setSubmitted(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setName('');
    setPick1(''); setPick2(''); setPick3('');
    setError('');
  };

  const selectedOdds = useMemo(() => {
    return [pick1, pick2, pick3]
      .map(id => field.find(p => p.id === id))
      .filter(Boolean)
      .map(p => ({ num: p.oddsNum, den: p.oddsDen }));
  }, [pick1, pick2, pick3, field]);

  const parlay = computeCombined(selectedOdds);
  const allSelected = pick1 && pick2 && pick3;
  const allUnique = new Set([pick1, pick2, pick3].filter(Boolean)).size === [pick1, pick2, pick3].filter(Boolean).length;
  const oddsValid = parlay >= 100;

  const canSubmit = name.trim() && allSelected && allUnique && oddsValid && !config.locked;

  const handleSubmit = async () => {
    setError('');
    if (!name.trim()) return setError('Add your name.');
    if (!allSelected) return setError('Pick three golfers.');
    if (!allUnique) return setError('Picks must be three different players.');
    if (!oddsValid) return setError(`Combined odds are ${formatCombined(parlay)} – must be 100/1 or longer.`);
    if (editingId) {
      await onUpdate(editingId, { name: name.trim(), picks: [pick1, pick2, pick3] });
    } else {
      await onSubmit({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: name.trim(),
        picks: [pick1, pick2, pick3],
        submittedAt: new Date().toISOString()
      });
    }
    setSubmitted(true);
    setTimeout(() => {
      setSubmitted(false);
      setEditingId(null);
      setName(''); setPick1(''); setPick2(''); setPick3('');
    }, 2500);
  };

  if (!config.setupComplete) {
    return (
      <div style={styles.emptyState}>
        <div style={styles.emptyIcon}>⛳</div>
        <h2 style={styles.emptyTitle}>Tournament not yet open</h2>
        <p style={styles.emptyText}>The field hasn't been published yet. Check back soon.</p>
      </div>
    );
  }

  if (config.locked) {
    return (
      <div style={styles.emptyState}>
        <div style={styles.emptyIcon}><Lock size={36} strokeWidth={1.5} /></div>
        <h2 style={styles.emptyTitle}>Entries are closed</h2>
        <p style={styles.emptyText}>
          The tournament is underway. Head to the Leaderboard to see how everyone's doing.
        </p>
        <SubmittedList entries={entries} field={field} />
      </div>
    );
  }

  if (submitted) {
    return (
      <div style={styles.emptyState}>
        <div style={{ ...styles.emptyIcon, color: '#2D4A35' }}><Check size={36} strokeWidth={2} /></div>
        <h2 style={styles.emptyTitle}>{editingId ? 'Entry updated' : 'Entry received'}</h2>
        <p style={styles.emptyText}>
          {editingId
            ? 'Your picks have been updated.'
            : "Good luck. Don't forget the £10 in the WhatsApp group."}
        </p>
      </div>
    );
  }

  return (
    <div style={styles.panel}>
      {editingId && (
        <div style={styles.editBanner}>
          <Edit3 size={14} />
          <span>You're editing <strong>{name || 'this entry'}</strong></span>
          <button onClick={handleCancelEdit} style={styles.editCancel}>Cancel edit</button>
        </div>
      )}
      <div style={styles.panelSection}>
        <label style={styles.label}>Your name</label>
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. Alex Morgan"
          style={styles.input}
        />
        <div style={styles.helpText}>
          Want to enter twice? Just submit again with a tag — like "Alex (2)".
        </div>
      </div>

      <div style={styles.panelSection}>
        <label style={styles.label}>Your team of three</label>
        {[
          [pick1, setPick1, 'First pick'],
          [pick2, setPick2, 'Second pick'],
          [pick3, setPick3, 'Third pick']
        ].map(([val, set, ph], i) => (
          <PlayerSelect
            key={i}
            value={val}
            onChange={set}
            field={sortedField}
            excludeIds={[pick1, pick2, pick3].filter((p, idx) => p && idx !== i)}
            placeholder={ph}
          />
        ))}
      </div>

      <ParlayCard parlay={parlay} valid={oddsValid} hasAll={allSelected} />

      {error && (
        <div style={styles.errorBox}>
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      <button
        onClick={handleSubmit}
        disabled={!canSubmit}
        style={{ ...styles.cta, ...(canSubmit ? {} : styles.ctaDisabled) }}
      >
        {editingId ? 'Update entry' : 'Submit entry'} <ArrowRight size={16} />
      </button>

      <SubmittedList entries={entries} field={field} onEdit={handleEdit} editingId={editingId} />
    </div>
  );
}

const PlayerSelect = ({ value, onChange, field, excludeIds, placeholder }) => (
  <div style={styles.selectWrap}>
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={styles.select}
    >
      <option value="">— {placeholder} —</option>
      {field.filter(p => !excludeIds.includes(p.id)).map(p => (
        <option key={p.id} value={p.id}>
          {p.name} ({formatOdds({ num: p.oddsNum, den: p.oddsDen })})
        </option>
      ))}
    </select>
  </div>
);

const ParlayCard = ({ parlay, valid, hasAll }) => (
  <div style={{
    ...styles.parlayCard,
    borderColor: hasAll ? (valid ? '#2D4A35' : '#A23E2E') : 'rgba(0,0,0,0.12)'
  }}>
    <div>
      <div style={styles.parlayLabel}>Combined odds</div>
      <div style={{
        ...styles.parlayValue,
        color: hasAll ? (valid ? '#2D4A35' : '#A23E2E') : 'rgba(0,0,0,0.3)'
      }}>
        {hasAll ? formatCombined(parlay) : '–'}
      </div>
    </div>
    <div style={styles.parlayStatus}>
      {hasAll ? (
        valid
          ? <><Check size={14} /> Qualifies (≥ 100/1)</>
          : <><X size={14} /> Too short (need 100/1+)</>
      ) : (
        <>Pick three to see odds</>
      )}
    </div>
  </div>
);

function SubmittedList({ entries, field, onEdit, editingId }) {
  if (!entries.length) return null;
  return (
    <div style={{ ...styles.panelSection, marginTop: 32 }}>
      <div style={styles.subhead}>
        <Users size={13} /> {entries.length} {entries.length === 1 ? 'entry' : 'entries'} so far
      </div>
      <div style={styles.entriesList}>
        {entries.map(e => (
          <div key={e.id} style={{
            ...styles.entryRow,
            ...(editingId === e.id ? styles.entryRowEditing : {})
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={styles.entryName}>{e.name}</div>
              <div style={styles.entryPicks}>
                {e.picks.map(pid => {
                  const p = field.find(x => x.id === pid);
                  return p ? p.name.split(' ').slice(-1)[0] : '?';
                }).join(' · ')}
              </div>
            </div>
            {onEdit && (
              <button onClick={() => onEdit(e)} style={styles.editBtn} title="Edit this entry">
                <Edit3 size={13} />
              </button>
            )}
          </div>
        ))}
      </div>
      {onEdit && (
        <div style={{ ...styles.helpText, marginTop: 10 }}>
          Tap the pencil to edit any entry up until lock-in.
        </div>
      )}
    </div>
  );
}

// ============================================================
// LEADERBOARD VIEW
// ============================================================

function LeaderboardView({ standings, field, config }) {
  if (!standings.length) {
    return (
      <div style={styles.emptyState}>
        <div style={styles.emptyIcon}><Trophy size={36} strokeWidth={1.5} /></div>
        <h2 style={styles.emptyTitle}>No entries yet</h2>
        <p style={styles.emptyText}>Once people submit picks, the leaderboard will appear here.</p>
      </div>
    );
  }

  const live = standings.filter(s => !s.eliminated);
  const out = standings.filter(s => s.eliminated);

  return (
    <div style={styles.panel}>
      {live.length > 0 && (
        <>
          <div style={styles.leaderboardHead}>
            <div style={styles.subhead}><Trophy size={13} /> Standing</div>
            <div style={styles.colHeaders}>
              <span>R1</span><span>R2</span><span>R3</span><span>R4</span><span style={{ fontWeight: 700 }}>TOT</span>
            </div>
          </div>
          {live.map((s, i) => (
            <LeaderboardRow key={s.entry.id} standing={s} rank={i + 1} field={field} />
          ))}
        </>
      )}
      {out.length > 0 && (
        <div style={{ marginTop: 32 }}>
          <div style={styles.subhead}><Skull size={13} /> Out</div>
          {out.map(s => (
            <LeaderboardRow key={s.entry.id} standing={s} rank={null} field={field} eliminated />
          ))}
        </div>
      )}
    </div>
  );
}

function LeaderboardRow({ standing, rank, field, eliminated }) {
  const [expanded, setExpanded] = useState(false);
  const { entry, resolved, total, roundTotals, elimReason, combinedOdds } = standing;
  return (
    <div style={{ ...styles.lbRow, opacity: eliminated ? 0.55 : 1 }}>
      <div style={styles.lbRowMain} onClick={() => setExpanded(!expanded)}>
        <div style={styles.lbRank}>
          {rank === 1 ? <Crown size={16} color="#B89968" /> : rank ? <span>{rank}</span> : '–'}
        </div>
        <div style={styles.lbName}>
          <div style={styles.lbNameText}>{entry.name}</div>
          <div style={styles.lbOdds}>{formatCombined(combinedOdds)} combined</div>
          {eliminated && <div style={styles.lbElim}>{elimReason}</div>}
        </div>
        <div style={styles.lbScores}>
          <span style={styles.lbScore}>{formatToPar(roundTotals.r1)}</span>
          <span style={styles.lbScore}>{formatToPar(roundTotals.r2)}</span>
          <span style={styles.lbScore}>{formatToPar(roundTotals.r3)}</span>
          <span style={styles.lbScore}>{formatToPar(roundTotals.r4)}</span>
          <span style={{ ...styles.lbScore, ...styles.lbTotal }}>{formatToPar(total)}</span>
        </div>
        <ChevronRight
          size={16}
          style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s', opacity: 0.4 }}
        />
      </div>
      {expanded && (
        <div style={styles.lbExpand}>
          {resolved.map((r, i) => (
            <div key={i} style={styles.lbPlayer}>
              <div>
                <span style={styles.lbPlayerName}>{r.current?.name || 'Unresolved'}</span>
                {r.substituted && (
                  <span style={styles.subBadge}>
                    sub for {r.original?.name?.split(' ').slice(-1)[0] || 'WD'}
                  </span>
                )}
                {r.current?.status === 'missed_cut' && <span style={styles.cutBadge}>MC</span>}
                {r.current?.status === 'wd_post_cut' && <span style={styles.cutBadge}>WD</span>}
              </div>
              <div style={styles.lbPlayerScores}>
                {['r1','r2','r3','r4'].map(k => (
                  <span key={k} style={styles.lbScore}>
                    {formatToPar(r.current?.scores?.[k])}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// ADMIN VIEW
// ============================================================

function AdminView({ config, field, entries, unlocked, setUnlocked, saveConfig, saveField, saveEntries }) {
  if (!unlocked) {
    return <AdminLogin config={config} saveConfig={saveConfig} onUnlock={() => setUnlocked(true)} />;
  }
  return (
    <AdminPanel
      config={config} field={field} entries={entries}
      saveConfig={saveConfig} saveField={saveField} saveEntries={saveEntries}
      onLogout={() => setUnlocked(false)}
    />
  );
}

function AdminLogin({ config, saveConfig, onUnlock }) {
  const [pin, setPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState('');

  const settingUp = !config.adminPin;

  const handle = async () => {
    setError('');
    if (settingUp) {
      if (newPin.length < 4) return setError('PIN must be at least 4 characters.');
      if (newPin !== confirmPin) return setError('PINs do not match.');
      await saveConfig({ ...config, adminPin: newPin });
      onUnlock();
    } else {
      if (pin === config.adminPin) onUnlock();
      else setError('Incorrect PIN.');
    }
  };

  return (
    <div style={{ ...styles.panel, maxWidth: 400, margin: '40px auto' }}>
      <div style={styles.adminLockIcon}><Lock size={28} strokeWidth={1.5} /></div>
      <h2 style={{ ...styles.h2, textAlign: 'center', marginBottom: 8 }}>
        {settingUp ? 'Set admin PIN' : 'Admin access'}
      </h2>
      <p style={{ ...styles.helpText, textAlign: 'center', marginBottom: 24 }}>
        {settingUp
          ? "First time here — choose a PIN you'll use to manage the tournament."
          : 'Enter your admin PIN to manage the tournament.'}
      </p>
      {settingUp ? (
        <>
          <input
            type="password" value={newPin} onChange={e => setNewPin(e.target.value)}
            placeholder="New PIN" style={styles.input} autoFocus
          />
          <input
            type="password" value={confirmPin} onChange={e => setConfirmPin(e.target.value)}
            placeholder="Confirm PIN" style={{ ...styles.input, marginTop: 12 }}
          />
        </>
      ) : (
        <input
          type="password" value={pin} onChange={e => setPin(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handle()}
          placeholder="PIN" style={styles.input} autoFocus
        />
      )}
      {error && <div style={styles.errorBox}><AlertTriangle size={14} /> {error}</div>}
      <button onClick={handle} style={{ ...styles.cta, marginTop: 16 }}>
        {settingUp ? 'Set PIN & enter' : 'Unlock'} <ArrowRight size={16} />
      </button>
    </div>
  );
}

function AdminPanel({ config, field, entries, saveConfig, saveField, saveEntries, onLogout }) {
  const [section, setSection] = useState('setup');
  const sections = [
    { id: 'setup', label: 'Setup' },
    { id: 'field', label: 'Field & Status' },
    { id: 'scores', label: 'Scores' },
    { id: 'entries', label: 'Entries' },
    { id: 'danger', label: 'Reset' }
  ];

  return (
    <div>
      <div style={styles.adminTopBar}>
        <div style={styles.adminSecTabs}>
          {sections.map(s => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              style={{
                ...styles.adminSecTab,
                ...(section === s.id ? styles.adminSecTabActive : {})
              }}
            >{s.label}</button>
          ))}
        </div>
        <button onClick={onLogout} style={styles.logoutBtn} title="Lock admin">
          <LogOut size={14} />
        </button>
      </div>
      <div style={styles.panel}>
        {section === 'setup' && <SetupSection config={config} saveConfig={saveConfig} field={field} />}
        {section === 'field' && <FieldSection field={field} saveField={saveField} />}
        {section === 'scores' && <ScoresSection field={field} saveField={saveField} />}
        {section === 'entries' && <EntriesSection entries={entries} field={field} saveEntries={saveEntries} />}
        {section === 'danger' && <DangerSection saveConfig={saveConfig} saveField={saveField} saveEntries={saveEntries} />}
      </div>
    </div>
  );
}

// --- Setup ---
function SetupSection({ config, saveConfig, field }) {
  const [name, setName] = useState(config.tournamentName);
  const [rawField, setRawField] = useState('');
  const [previewField, setPreviewField] = useState([]);
  const [feedback, setFeedback] = useState('');

  const handleParse = () => {
    const parsed = parseFieldList(rawField);
    setPreviewField(parsed);
    setFeedback(parsed.length ? `Parsed ${parsed.length} players. Review and save below.` : 'Nothing parsed — check the format.');
  };

  const handleSave = async () => {
    if (!name.trim()) return setFeedback('Add a tournament name first.');
    if (!previewField.length) return setFeedback('Parse the field first.');
    await saveConfig({ ...config, tournamentName: name.trim(), setupComplete: true });
    await storageSet(KEYS.FIELD, previewField);
    window.location.reload();
  };

  const handleNameOnly = async () => {
    await saveConfig({ ...config, tournamentName: name.trim() });
    setFeedback('Tournament name updated.');
  };

  const handleLockToggle = async () => {
    await saveConfig({ ...config, locked: !config.locked });
  };

  return (
    <div>
      <h3 style={styles.h3}>Tournament</h3>
      <label style={styles.label}>Tournament name</label>
      <input
        type="text" value={name} onChange={e => setName(e.target.value)}
        placeholder="e.g. 2026 PGA Championship"
        style={styles.input}
      />
      {field.length > 0 && (
        <button onClick={handleNameOnly} style={{ ...styles.secondaryBtn, marginTop: 8 }}>
          Update name only
        </button>
      )}

      <div style={styles.divider} />

      <h3 style={styles.h3}>Field & odds</h3>
      <p style={styles.helpText}>
        Paste the list of players and their odds, one per line.
        Examples: <code>Scottie Scheffler 9/2</code>, <code>Rory McIlroy, 7/1</code>, <code>Xander Schauffele | 10/1</code>.
        {field.length > 0 && <strong> Note: re-saving will replace the current field and clear any scores.</strong>}
      </p>
      <textarea
        value={rawField}
        onChange={e => setRawField(e.target.value)}
        placeholder={'Scottie Scheffler 9/2\nRory McIlroy 7/1\nXander Schauffele 10/1\n…'}
        style={{ ...styles.input, height: 220, fontFamily: 'JetBrains Mono, monospace', fontSize: 13 }}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button onClick={handleParse} style={styles.secondaryBtn}>Parse</button>
        {previewField.length > 0 && (
          <button onClick={handleSave} style={styles.cta}>
            Save field ({previewField.length}) <ArrowRight size={16} />
          </button>
        )}
      </div>
      {feedback && <div style={styles.infoBox}>{feedback}</div>}
      {previewField.length > 0 && (
        <div style={{ marginTop: 16, maxHeight: 240, overflowY: 'auto', border: '1px solid rgba(0,0,0,0.08)', borderRadius: 6, padding: 8 }}>
          {sortByOdds(previewField).map(p => (
            <div key={p.id} style={styles.previewRow}>
              <span>{p.name}</span>
              <span style={styles.mono}>{formatOdds({ num: p.oddsNum, den: p.oddsDen })}</span>
            </div>
          ))}
        </div>
      )}

      <div style={styles.divider} />

      <h3 style={styles.h3}>Entry window</h3>
      <p style={styles.helpText}>
        When the first player tees off, lock entries so no more picks can be submitted.
      </p>
      <button onClick={handleLockToggle} style={config.locked ? styles.secondaryBtn : styles.cta}>
        {config.locked ? <><Unlock size={14} /> Re-open entries</> : <><Lock size={14} /> Lock entries</>}
      </button>
    </div>
  );
}

// --- Field & status ---
function FieldSection({ field, saveField }) {
  if (!field.length) {
    return <div style={styles.helpText}>No field set up yet — head to Setup first.</div>;
  }
  const sorted = sortByOdds(field);

  const updateStatus = async (id, status) => {
    await saveField(field.map(p => p.id === id ? { ...p, status } : p));
  };

  return (
    <div>
      <h3 style={styles.h3}>Player status</h3>
      <p style={styles.helpText}>
        Set each player's status as the tournament unfolds.<br />
        <strong>WD pre-cut</strong> = withdrew before/during R1 or R2; substitution kicks in.<br />
        <strong>Missed cut</strong> = made it through R1 and R2 but missed the cut; entrants with this player are out.<br />
        <strong>WD post-cut</strong> = made the cut, then withdrew during R3 or R4; entrants are out.
      </p>
      <div style={styles.fieldTable}>
        {sorted.map(p => (
          <div key={p.id} style={styles.fieldRow}>
            <div style={styles.fieldName}>
              <span>{p.name}</span>
              <span style={styles.fieldOdds}>{formatOdds({ num: p.oddsNum, den: p.oddsDen })}</span>
            </div>
            <div style={styles.statusBtns}>
              {[
                ['active', 'In'],
                ['wd_pre_cut', 'WD pre'],
                ['missed_cut', 'MC'],
                ['wd_post_cut', 'WD post']
              ].map(([s, l]) => (
                <button
                  key={s}
                  onClick={() => updateStatus(p.id, s)}
                  style={{
                    ...styles.statusBtn,
                    ...(p.status === s ? styles.statusBtnActive : {}),
                    ...(p.status === s && s !== 'active' ? styles.statusBtnDanger : {})
                  }}
                >{l}</button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Scores ---
function ScoresSection({ field, saveField }) {
  const [search, setSearch] = useState('');
  if (!field.length) {
    return <div style={styles.helpText}>No field set up yet — head to Setup first.</div>;
  }

  const sorted = sortByOdds(field);
  const filtered = search
    ? sorted.filter(p => p.name.toLowerCase().includes(search.toLowerCase()))
    : sorted;

  const updateScore = async (id, round, value) => {
    const next = field.map(p => {
      if (p.id !== id) return p;
      const scores = { ...p.scores };
      if (value === undefined || value === null) delete scores[round];
      else scores[round] = value;
      return { ...p, scores };
    });
    await saveField(next);
  };

  return (
    <div>
      <h3 style={styles.h3}>Score to par by round</h3>
      <p style={styles.helpText}>
        Enter each player's score to par for each round. Use <code>-3</code>, <code>0</code>, <code>+4</code>, or just <code>3</code> / <code>-2</code>. Leave blank if not played.
      </p>
      <input
        type="text" value={search} onChange={e => setSearch(e.target.value)}
        placeholder="Filter players…" style={styles.input}
      />
      <div style={{ ...styles.fieldTable, marginTop: 12 }}>
        <div style={styles.scoreHead}>
          <span>Player</span>
          <span>R1</span><span>R2</span><span>R3</span><span>R4</span>
        </div>
        {filtered.map(p => (
          <div key={p.id} style={styles.scoreRow}>
            <div style={styles.scoreNameCell}>
              <span>{p.name}</span>
              {p.status !== 'active' && (
                <span style={styles.statusTag}>
                  {p.status === 'wd_pre_cut' ? 'WD pre' :
                   p.status === 'missed_cut' ? 'MC' :
                   p.status === 'wd_post_cut' ? 'WD post' : ''}
                </span>
              )}
            </div>
            {['r1','r2','r3','r4'].map(r => (
              <ScoreInput
                key={r}
                value={p.scores[r]}
                onChange={(v) => updateScore(p.id, r, v)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// Score input that tolerates intermediate states ("-", "+") while typing
// negative scores. Commits to parent only when the value parses as a number
// or the field is cleared.
function ScoreInput({ value, onChange }) {
  const [text, setText] = useState(
    value === undefined || value === null ? '' : String(value)
  );

  // Sync from outside (e.g. score reset), but don't overwrite an intermediate
  // state the user is mid-typing.
  useEffect(() => {
    if (text === '-' || text === '+') return;
    const incoming = value === undefined || value === null ? '' : String(value);
    if (incoming !== text) setText(incoming);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const handleChange = (e) => {
    const raw = e.target.value;
    setText(raw);
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed === '-' || trimmed === '+') {
      onChange(undefined);
      return;
    }
    const n = Number(trimmed);
    if (Number.isFinite(n)) onChange(n);
  };

  const handleBlur = () => {
    const trimmed = text.trim();
    if (trimmed === '' || trimmed === '-' || trimmed === '+') {
      setText('');
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      setText(value === undefined || value === null ? '' : String(value));
    }
  };

  return (
    <input
      type="text"
      value={text}
      onChange={handleChange}
      onBlur={handleBlur}
      style={styles.scoreInput}
    />
  );
}

// --- Entries (admin can edit or delete) ---
function EntriesSection({ entries, field, saveEntries }) {
  const [editingId, setEditingId] = useState(null);
  if (!entries.length) {
    return <div style={styles.helpText}>No entries yet.</div>;
  }
  const handleDelete = async (id) => {
    if (!confirm('Delete this entry? This cannot be undone.')) return;
    await saveEntries(entries.filter(e => e.id !== id));
  };
  const handleSave = async (id, updates) => {
    await saveEntries(entries.map(e => e.id === id
      ? { ...e, ...updates, editedAt: new Date().toISOString() }
      : e
    ));
    setEditingId(null);
  };
  return (
    <div>
      <h3 style={styles.h3}>Entries ({entries.length})</h3>
      <p style={styles.helpText}>
        Edit teams to apply withdrawal substitutions, or delete duplicates and mistakes. Admin edits bypass the 100/1 minimum — useful when a substitute drops a team below the threshold.
      </p>
      {entries.map(e => (
        editingId === e.id ? (
          <AdminEntryEditor
            key={e.id} entry={e} field={field}
            onSave={(updates) => handleSave(e.id, updates)}
            onCancel={() => setEditingId(null)}
          />
        ) : (
          <div key={e.id} style={styles.entryAdminRow}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{e.name}</div>
              <div style={styles.entryPicks}>
                {e.picks.map(pid => {
                  const p = field.find(x => x.id === pid);
                  return p ? `${p.name} (${formatOdds({ num: p.oddsNum, den: p.oddsDen })})` : '?';
                }).join(' · ')}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => setEditingId(e.id)} style={styles.editBtn} title="Edit entry">
                <Edit3 size={13} />
              </button>
              <button onClick={() => handleDelete(e.id)} style={styles.iconBtn} title="Delete entry">
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        )
      ))}
    </div>
  );
}

function AdminEntryEditor({ entry, field, onSave, onCancel }) {
  const [name, setName] = useState(entry.name);
  const [pick1, setPick1] = useState(entry.picks[0] || '');
  const [pick2, setPick2] = useState(entry.picks[1] || '');
  const [pick3, setPick3] = useState(entry.picks[2] || '');
  const sorted = useMemo(() => sortByOdds(field), [field]);
  const handleSave = () => {
    onSave({ name: name.trim() || entry.name, picks: [pick1, pick2, pick3] });
  };
  return (
    <div style={{
      ...styles.entryAdminRow,
      ...styles.entryRowEditing,
      flexDirection: 'column', alignItems: 'stretch', gap: 10, padding: 14
    }}>
      <input
        type="text" value={name} onChange={e => setName(e.target.value)}
        placeholder="Entrant name" style={styles.input}
      />
      {[[pick1, setPick1], [pick2, setPick2], [pick3, setPick3]].map(([v, set], i) => (
        <PlayerSelect
          key={i} value={v} onChange={set} field={sorted}
          excludeIds={[pick1, pick2, pick3].filter((p, idx) => p && idx !== i)}
          placeholder={`Pick ${i + 1}`}
        />
      ))}
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={handleSave} style={{ ...styles.cta, marginTop: 0 }}>
          Save changes <Check size={16} />
        </button>
        <button onClick={onCancel} style={styles.secondaryBtn}>Cancel</button>
      </div>
    </div>
  );
}

// --- Reset ---
function DangerSection({ saveConfig, saveField, saveEntries }) {
  const [confirmText, setConfirmText] = useState('');
  const handleReset = async () => {
    if (confirmText !== 'reset') return;
    await saveConfig(DEFAULT_CONFIG);
    await saveField([]);
    await saveEntries([]);
    window.location.reload();
  };
  const handleClearScores = async () => {
    if (!confirm('Clear all scores but keep field, entries, and tournament name?')) return;
    const f = await storageGet(KEYS.FIELD, []);
    const cleared = f.map(p => ({ ...p, scores: {}, status: 'active' }));
    await saveField(cleared);
  };
  return (
    <div>
      <h3 style={styles.h3}>Between majors</h3>
      <p style={styles.helpText}>
        After a major finishes, clear scores & statuses ready for the next one. The field and entries will be wiped — you'll set those up again for the next tournament via the Setup tab.
      </p>
      <button onClick={handleClearScores} style={styles.secondaryBtn}>
        Clear all scores & player statuses
      </button>

      <div style={styles.divider} />

      <h3 style={{ ...styles.h3, color: '#A23E2E' }}>Full reset</h3>
      <p style={styles.helpText}>
        This wipes everything: tournament name, field, all entries, scores, and the admin PIN. Type <code>reset</code> to confirm.
      </p>
      <input
        type="text" value={confirmText} onChange={e => setConfirmText(e.target.value)}
        placeholder="type reset" style={styles.input}
      />
      <button
        onClick={handleReset}
        disabled={confirmText !== 'reset'}
        style={{
          ...styles.cta,
          background: '#A23E2E',
          ...(confirmText !== 'reset' ? styles.ctaDisabled : {}),
          marginTop: 12
        }}
      >
        Reset everything
      </button>
    </div>
  );
}

// ============================================================
// STYLES
// ============================================================

const globalCSS = `
  * { box-sizing: border-box; }
  button { font-family: inherit; cursor: pointer; }
  input, select, textarea { font-family: inherit; }
  select { -webkit-appearance: none; appearance: none; background-image: url("data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20292.4%20292.4%22%3E%3Cpath%20fill%3D%22%231a1a1a%22%20d%3D%22M287%2069.4a17.6%2017.6%200%200%200-13-5.4H18.4c-5%200-9.3%201.8-12.9%205.4A17.6%2017.6%200%200%200%200%2082.2c0%205%201.8%209.3%205.4%2012.9l128%20127.9c3.6%203.6%207.8%205.4%2012.8%205.4s9.2-1.8%2012.8-5.4L287%2095c3.5-3.5%205.4-7.8%205.4-12.8%200-5-1.9-9.2-5.5-12.8z%22%2F%3E%3C%2Fsvg%3E"); background-repeat: no-repeat; background-position: right 14px center; background-size: 10px; padding-right: 36px !important; }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.15); border-radius: 4px; }
`;

const styles = {
  shell: {
    minHeight: '100vh',
    background: 'linear-gradient(180deg, #F5EFE2 0%, #EFE7D4 100%)',
    color: '#1A1F2E',
    fontFamily: '"DM Sans", -apple-system, system-ui, sans-serif',
    fontSize: 14,
    lineHeight: 1.5
  },
  container: { maxWidth: 720, margin: '0 auto', padding: '24px 16px 80px' },
  content: { marginTop: 20 },
  center: { display: 'flex', alignItems: 'center', justifyContent: 'center' },

  // Header
  header: { borderBottom: '1px solid rgba(0,0,0,0.08)', paddingBottom: 20 },
  headerTop: { display: 'flex', alignItems: 'flex-start', gap: 14 },
  flag: { fontFamily: 'Fraunces, serif', fontSize: 32, color: '#2D4A35', lineHeight: 1, marginTop: 2 },
  eyebrow: { fontSize: 11, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'rgba(26,31,46,0.5)', fontWeight: 500 },
  title: {
    fontFamily: 'Fraunces, serif',
    fontWeight: 600,
    fontSize: 30,
    lineHeight: 1.1,
    margin: '4px 0 0',
    letterSpacing: '-0.02em',
    fontVariationSettings: '"opsz" 60'
  },
  lockBadge: {
    background: '#2D4A35', color: '#F5EFE2', fontSize: 11,
    padding: '4px 10px', borderRadius: 999, display: 'flex',
    alignItems: 'center', gap: 4, fontWeight: 500, letterSpacing: '0.03em'
  },

  // Tabs
  tabs: { display: 'flex', gap: 4, marginTop: 20, borderBottom: '1px solid rgba(0,0,0,0.08)' },
  tab: {
    flex: 1, background: 'transparent', border: 'none',
    padding: '12px 8px', fontSize: 13, fontWeight: 500,
    color: 'rgba(26,31,46,0.55)', display: 'flex',
    alignItems: 'center', justifyContent: 'center', gap: 6,
    borderBottom: '2px solid transparent', transition: 'all 0.2s'
  },
  tabActive: {
    color: '#2D4A35', borderBottomColor: '#2D4A35', fontWeight: 600
  },

  // Footer
  footer: {
    marginTop: 40, paddingTop: 20, borderTop: '1px solid rgba(0,0,0,0.08)',
    fontSize: 11, letterSpacing: '0.05em', color: 'rgba(26,31,46,0.45)',
    textAlign: 'center'
  },

  // Panels & generic
  panel: {
    background: '#FAF6EC',
    border: '1px solid rgba(0,0,0,0.06)',
    borderRadius: 8,
    padding: 24,
    boxShadow: '0 1px 2px rgba(0,0,0,0.02)'
  },
  panelSection: { marginBottom: 24 },
  h2: { fontFamily: 'Fraunces, serif', fontSize: 22, fontWeight: 600, margin: 0, letterSpacing: '-0.01em' },
  h3: { fontFamily: 'Fraunces, serif', fontSize: 16, fontWeight: 600, margin: '0 0 12px', letterSpacing: '-0.005em' },
  label: {
    display: 'block', fontSize: 11, letterSpacing: '0.12em',
    textTransform: 'uppercase', color: 'rgba(26,31,46,0.6)',
    fontWeight: 600, marginBottom: 8
  },
  subhead: {
    fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase',
    color: 'rgba(26,31,46,0.55)', fontWeight: 600, marginBottom: 12,
    display: 'flex', alignItems: 'center', gap: 6
  },
  helpText: { fontSize: 12, color: 'rgba(26,31,46,0.6)', lineHeight: 1.5, marginTop: 6 },
  input: {
    width: '100%', padding: '12px 14px', fontSize: 14,
    background: '#FFF', border: '1px solid rgba(0,0,0,0.12)',
    borderRadius: 6, color: '#1A1F2E', outline: 'none',
    transition: 'border-color 0.15s'
  },
  selectWrap: { marginBottom: 10 },
  select: {
    width: '100%', padding: '12px 14px', fontSize: 14,
    background: '#FFF', border: '1px solid rgba(0,0,0,0.12)',
    borderRadius: 6, color: '#1A1F2E', outline: 'none'
  },
  divider: { height: 1, background: 'rgba(0,0,0,0.08)', margin: '28px 0' },
  mono: { fontFamily: '"JetBrains Mono", monospace', fontSize: 12 },

  cta: {
    width: '100%', padding: '14px 20px', fontSize: 14, fontWeight: 600,
    background: '#2D4A35', color: '#F5EFE2', border: 'none',
    borderRadius: 6, display: 'flex', alignItems: 'center',
    justifyContent: 'center', gap: 8, letterSpacing: '0.02em',
    transition: 'background 0.15s', marginTop: 8
  },
  ctaDisabled: {
    background: 'rgba(0,0,0,0.18)', color: '#FFF', cursor: 'not-allowed'
  },
  secondaryBtn: {
    padding: '10px 16px', fontSize: 13, fontWeight: 500,
    background: 'transparent', color: '#1A1F2E',
    border: '1px solid rgba(0,0,0,0.18)', borderRadius: 6,
    display: 'inline-flex', alignItems: 'center', gap: 6,
    transition: 'background 0.15s'
  },
  iconBtn: {
    width: 30, height: 30, border: '1px solid rgba(0,0,0,0.12)',
    background: 'transparent', borderRadius: 6,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: '#A23E2E'
  },
  errorBox: {
    marginTop: 12, padding: '10px 12px', background: 'rgba(162,62,46,0.08)',
    border: '1px solid rgba(162,62,46,0.2)', borderRadius: 6,
    fontSize: 13, color: '#A23E2E',
    display: 'flex', alignItems: 'center', gap: 8
  },
  infoBox: {
    marginTop: 12, padding: '10px 12px', background: 'rgba(45,74,53,0.06)',
    border: '1px solid rgba(45,74,53,0.16)', borderRadius: 6,
    fontSize: 13, color: '#2D4A35'
  },

  // Parlay card
  parlayCard: {
    background: '#FFF', border: '2px solid rgba(0,0,0,0.12)',
    borderRadius: 8, padding: '16px 20px', marginTop: 20,
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    transition: 'border-color 0.2s', gap: 16
  },
  parlayLabel: {
    fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
    color: 'rgba(26,31,46,0.55)', fontWeight: 600
  },
  parlayValue: {
    fontFamily: '"JetBrains Mono", monospace', fontSize: 24, fontWeight: 700,
    marginTop: 2, letterSpacing: '-0.02em'
  },
  parlayStatus: {
    fontSize: 12, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6,
    color: 'rgba(26,31,46,0.7)', textAlign: 'right'
  },

  // Submitted list
  entriesList: { display: 'flex', flexDirection: 'column', gap: 6 },
  entryRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '10px 12px', background: 'rgba(255,255,255,0.6)',
    borderRadius: 4, fontSize: 13, gap: 10
  },
  entryRowEditing: {
    background: 'rgba(184,153,104,0.18)',
    boxShadow: 'inset 0 0 0 1px rgba(184,153,104,0.45)'
  },
  entryName: { fontWeight: 600 },
  entryPicks: { fontSize: 12, color: 'rgba(26,31,46,0.6)', fontStyle: 'italic', marginTop: 2 },
  editBtn: {
    width: 30, height: 30, background: 'transparent',
    border: '1px solid rgba(0,0,0,0.12)', borderRadius: 6,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: 'rgba(26,31,46,0.6)', flexShrink: 0
  },
  editBanner: {
    background: 'rgba(184,153,104,0.18)',
    border: '1px solid rgba(184,153,104,0.4)',
    padding: '10px 14px', borderRadius: 6, marginBottom: 20,
    fontSize: 12, color: '#7A5A2E', fontWeight: 500,
    display: 'flex', alignItems: 'center', gap: 8
  },
  editCancel: {
    marginLeft: 'auto', background: 'transparent', border: 'none',
    fontSize: 12, color: '#7A5A2E', textDecoration: 'underline',
    cursor: 'pointer', padding: 0, fontWeight: 500
  },

  // Empty state
  emptyState: { textAlign: 'center', padding: '60px 20px' },
  emptyIcon: { fontSize: 40, marginBottom: 16, color: 'rgba(26,31,46,0.4)' },
  emptyTitle: { fontFamily: 'Fraunces, serif', fontSize: 22, fontWeight: 600, margin: 0 },
  emptyText: { marginTop: 8, color: 'rgba(26,31,46,0.6)', fontSize: 14 },

  // Leaderboard
  leaderboardHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 },
  colHeaders: {
    display: 'grid', gridTemplateColumns: 'repeat(5, 32px)', gap: 4,
    fontSize: 10, letterSpacing: '0.1em', color: 'rgba(26,31,46,0.45)',
    fontWeight: 600, textAlign: 'center'
  },
  lbRow: { borderTop: '1px solid rgba(0,0,0,0.06)' },
  lbRowMain: {
    display: 'flex', alignItems: 'center', padding: '12px 0',
    gap: 8, cursor: 'pointer'
  },
  lbRank: {
    width: 28, fontFamily: 'Fraunces, serif', fontSize: 18, fontWeight: 600,
    color: '#2D4A35', display: 'flex', alignItems: 'center', justifyContent: 'center'
  },
  lbName: { flex: 1, minWidth: 0 },
  lbNameText: { fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  lbElim: { fontSize: 11, color: '#A23E2E', marginTop: 2, fontStyle: 'italic' },
  lbOdds: {
    fontSize: 11, color: 'rgba(26,31,46,0.55)', marginTop: 2,
    fontFamily: '"JetBrains Mono", monospace'
  },
  lbScores: { display: 'grid', gridTemplateColumns: 'repeat(5, 32px)', gap: 4 },
  lbScore: {
    fontFamily: '"JetBrains Mono", monospace', fontSize: 12,
    textAlign: 'center', color: 'rgba(26,31,46,0.75)'
  },
  lbTotal: { fontWeight: 700, color: '#2D4A35', fontSize: 13 },
  lbExpand: {
    padding: '8px 0 16px 36px', borderTop: '1px dashed rgba(0,0,0,0.08)',
    display: 'flex', flexDirection: 'column', gap: 6
  },
  lbPlayer: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    fontSize: 12, gap: 8
  },
  lbPlayerName: { color: 'rgba(26,31,46,0.85)' },
  lbPlayerScores: { display: 'grid', gridTemplateColumns: 'repeat(4, 32px)', gap: 4 },
  subBadge: {
    fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase',
    marginLeft: 6, padding: '2px 5px', borderRadius: 3,
    background: 'rgba(184,153,104,0.18)', color: '#7A5A2E'
  },
  cutBadge: {
    fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase',
    marginLeft: 6, padding: '2px 5px', borderRadius: 3,
    background: 'rgba(162,62,46,0.12)', color: '#A23E2E', fontWeight: 600
  },

  // Admin
  adminLockIcon: {
    width: 56, height: 56, borderRadius: '50%', background: 'rgba(45,74,53,0.1)',
    color: '#2D4A35', display: 'flex', alignItems: 'center', justifyContent: 'center',
    margin: '0 auto 16px'
  },
  adminTopBar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12 },
  adminSecTabs: { display: 'flex', gap: 4, flexWrap: 'wrap' },
  adminSecTab: {
    padding: '6px 12px', fontSize: 12, fontWeight: 500,
    background: 'transparent', color: 'rgba(26,31,46,0.6)',
    border: '1px solid rgba(0,0,0,0.1)', borderRadius: 999
  },
  adminSecTabActive: {
    background: '#1A1F2E', color: '#F5EFE2', borderColor: '#1A1F2E'
  },
  logoutBtn: {
    width: 32, height: 32, background: 'transparent',
    border: '1px solid rgba(0,0,0,0.1)', borderRadius: 6,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: 'rgba(26,31,46,0.6)'
  },

  // Field & status
  fieldTable: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 12 },
  fieldRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '10px 12px', background: 'rgba(255,255,255,0.7)',
    borderRadius: 4, gap: 12, flexWrap: 'wrap'
  },
  fieldName: { fontSize: 13, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 10 },
  fieldOdds: { fontFamily: '"JetBrains Mono", monospace', fontSize: 11, color: 'rgba(26,31,46,0.55)' },
  statusBtns: { display: 'flex', gap: 4 },
  statusBtn: {
    padding: '4px 8px', fontSize: 11, fontWeight: 500,
    background: 'transparent', color: 'rgba(26,31,46,0.55)',
    border: '1px solid rgba(0,0,0,0.12)', borderRadius: 4
  },
  statusBtnActive: { background: '#2D4A35', color: '#F5EFE2', borderColor: '#2D4A35' },
  statusBtnDanger: { background: '#A23E2E', borderColor: '#A23E2E' },

  // Scores
  scoreHead: {
    display: 'grid', gridTemplateColumns: '1fr repeat(4, 48px)', gap: 6,
    fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase',
    color: 'rgba(26,31,46,0.5)', fontWeight: 600, padding: '0 10px 6px'
  },
  scoreRow: {
    display: 'grid', gridTemplateColumns: '1fr repeat(4, 48px)', gap: 6,
    alignItems: 'center', padding: '4px 10px', background: 'rgba(255,255,255,0.6)',
    borderRadius: 4
  },
  scoreNameCell: { fontSize: 13, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 8 },
  scoreInput: {
    width: '100%', padding: '6px 4px', textAlign: 'center',
    fontFamily: '"JetBrains Mono", monospace', fontSize: 13,
    background: '#FFF', border: '1px solid rgba(0,0,0,0.12)',
    borderRadius: 4, outline: 'none'
  },
  statusTag: {
    fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase',
    padding: '2px 5px', borderRadius: 3,
    background: 'rgba(162,62,46,0.12)', color: '#A23E2E', fontWeight: 600
  },

  // Preview
  previewRow: {
    display: 'flex', justifyContent: 'space-between',
    padding: '4px 8px', fontSize: 12,
    borderBottom: '1px dashed rgba(0,0,0,0.06)'
  },

  // Entries admin
  entryAdminRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '12px 14px', background: 'rgba(255,255,255,0.7)',
    borderRadius: 4, marginBottom: 6, gap: 12
  }
};
