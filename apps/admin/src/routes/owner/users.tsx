import { useEffect, useState, type FormEvent } from "react";
import { Shell } from "../../components/Shell.js";
import { Modal } from "../../components/Modal.js";
import { api, ApiError } from "../../lib/api.js";
import { formatDateTime } from "../../lib/format.js";
import { InlineLoader } from "../../components/Spinner.js";
import { GateEditor, type GateValue } from "../../components/GateEditor.js";
import type { AdminRole } from "@ms/shared";

type Role = AdminRole;

interface AdminUserRow {
  id: string;
  email: string;
  phone: string | null;
  role: Role;
  branchId: string | null;
  isActive: boolean;
  failedLoginCount: number;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  permissionOverrides: GateValue;
}
interface Branch {
  id: string;
  name: string;
}

function rolePill(role: Role): JSX.Element {
  if (role === "owner") return <span className="pill pill--grad">Owner</span>;
  if (role === "admin") return <span className="pill pill--accent">Admin</span>;
  if (role === "manager") return <span className="pill pill--warning">Manager</span>;
  return <span className="pill">Staff</span>;
}

export function UsersPage(): JSX.Element {
  const [rows, setRows] = useState<AdminUserRow[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [resetFor, setResetFor] = useState<AdminUserRow | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const [u, b] = await Promise.all([
        api<{ data: AdminUserRow[] }>(`/admin/users`),
        api<{ data: Branch[] }>(`/branches`),
      ]);
      setRows(u.data);
      setBranches(b.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function toggleActive(u: AdminUserRow): Promise<void> {
    setActing(u.id);
    try {
      await api(`/admin/users/${u.id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_active: !u.isActive }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(null);
    }
  }

  const branchName = (id: string | null): string =>
    !id ? "—" : branches.find((b) => b.id === id)?.name ?? id.slice(0, 8);

  return (
    <Shell
      title="Admin users"
      actions={
        <button type="button" className="btn btn--primary btn--sm" onClick={() => setShowInvite(true)}>
          + Invite user
        </button>
      }
    >
      {error && (
        <div
          className="card"
          style={{ borderColor: "rgba(220,38,38,0.25)", color: "var(--danger)", marginBottom: 16 }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <InlineLoader />
      ) : rows.length === 0 ? (
        <div className="empty">
          <div className="empty__title">No admin users yet</div>
          Invite your first team member.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Branch</th>
                <th>Status</th>
                <th>Last login</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id}>
                  <td style={{ fontWeight: 600 }}>{u.email}</td>
                  <td>{rolePill(u.role)}</td>
                  <td>{branchName(u.branchId)}</td>
                  <td>
                    {u.isActive ? (
                      <span className="pill pill--success">Active</span>
                    ) : (
                      <span className="pill pill--ink">Disabled</span>
                    )}
                    {u.lockedUntil && new Date(u.lockedUntil) > new Date() && (
                      <span className="pill pill--danger" style={{ marginLeft: 6 }}>
                        Locked
                      </span>
                    )}
                  </td>
                  <td style={{ color: "var(--ink-soft)", fontSize: 13 }}>
                    {u.lastLoginAt ? formatDateTime(u.lastLoginAt) : "Never"}
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button
                      type="button"
                      className="btn btn--subtle btn--sm"
                      style={{ marginRight: 6 }}
                      onClick={() => setResetFor(u)}
                    >
                      Reset password
                    </button>
                    <button
                      type="button"
                      className={u.isActive ? "btn btn--subtle btn--sm" : "btn btn--primary btn--sm"}
                      disabled={acting === u.id}
                      onClick={() => void toggleActive(u)}
                    >
                      {acting === u.id ? "…" : u.isActive ? "Disable" : "Enable"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showInvite && (
        <InviteModal
          branches={branches}
          onClose={() => setShowInvite(false)}
          onSaved={() => {
            setShowInvite(false);
            void load();
          }}
        />
      )}
      {resetFor && (
        <ResetPasswordModal
          user={resetFor}
          onClose={() => setResetFor(null)}
          onSaved={() => setResetFor(null)}
        />
      )}
    </Shell>
  );
}

function InviteModal({
  branches,
  onClose,
  onSaved,
}: {
  branches: Branch[];
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("branch_staff");
  const [branchId, setBranchId] = useState<string>(branches[0]?.id ?? "");
  const [password, setPassword] = useState("");
  const [gates, setGates] = useState<GateValue>({ granted: [], revoked: [] });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function genPassword(): void {
    const chars =
      "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&";
    let out = "";
    for (let i = 0; i < 16; i++) out += chars[Math.floor(Math.random() * chars.length)];
    setPassword(out);
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api(`/admin/users`, {
        method: "POST",
        body: JSON.stringify({
          email,
          role,
          branch_id: role === "owner" || role === "admin" ? null : branchId || null,
          password,
          permission_overrides: gates,
        }),
      });
      onSaved();
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  const needsBranch = role === "manager" || role === "branch_staff";

  return (
    <Modal title="Invite user" onClose={onClose}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="field">
          <label className="field__label">Email</label>
          <input
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: needsBranch ? "1fr 1fr" : "1fr", gap: 12 }}>
          <div className="field">
            <label className="field__label">Role</label>
            <select
              className="select"
              value={role}
              onChange={(e) => {
                setRole(e.target.value as Role);
                setGates({ granted: [], revoked: [] });
              }}
            >
              <option value="branch_staff">Branch staff</option>
              <option value="manager">Manager</option>
              <option value="admin">Admin</option>
              <option value="owner">Owner</option>
            </select>
          </div>
          {needsBranch && (
            <div className="field">
              <label className="field__label">Branch</label>
              <select
                className="select"
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
                required
              >
                <option value="">Pick a branch…</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        <GateEditor role={role} value={gates} onChange={setGates} />
        <div className="field">
          <label className="field__label">Temporary password (12+ chars)</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={12}
              required
              style={{ fontFamily: "monospace" }}
            />
            <button type="button" className="btn btn--subtle btn--sm" onClick={genPassword}>
              Generate
            </button>
          </div>
          <span className="field__hint">
            Share this with the user securely. They should change it on first login.
          </span>
        </div>
        {error && <div className="field__error">{error}</div>}
        <button type="submit" className="btn btn--primary btn--block" disabled={submitting}>
          {submitting ? "Inviting…" : "Send invite"}
        </button>
      </form>
    </Modal>
  );
}

function ResetPasswordModal({
  user,
  onClose,
  onSaved,
}: {
  user: AdminUserRow;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api(`/admin/users/${user.id}/reset-password`, {
        method: "PATCH",
        body: JSON.stringify({ password }),
      });
      setDone(true);
      setTimeout(onSaved, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <Modal title={`Reset password · ${user.email}`} onClose={onClose}>
      {done ? (
        <p style={{ color: "var(--success)", margin: 0 }}>Password reset. Share the new one with the user.</p>
      ) : (
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="field">
            <label className="field__label">New password (12+ chars)</label>
            <input
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={12}
              required
              autoFocus
              style={{ fontFamily: "monospace" }}
            />
          </div>
          {error && <div className="field__error">{error}</div>}
          <button type="submit" className="btn btn--primary btn--block" disabled={submitting || !password}>
            {submitting ? "Resetting…" : "Reset password"}
          </button>
        </form>
      )}
    </Modal>
  );
}

