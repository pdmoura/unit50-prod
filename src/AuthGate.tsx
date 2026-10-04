import { createContext, useContext, useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { House, LogIn } from "lucide-react";
import { initAuth, signOut } from "./auth";
import { api } from "./api";

// Who is signed in, for the app shell. email is null when sign-in is off.
const Account = createContext<{
  email: string | null;
  signOut: (() => void) | null;
}>({ email: null, signOut: null });
export const useAccount = () => useContext(Account);

type State =
  | { step: "loading" }
  | { step: "failed"; message: string }
  | { step: "open" }
  | { step: "signed-out"; message?: string; attempt?: number }
  | { step: "signed-in"; email: string };

// Shows the app only to a signed-in person whose account is enabled for Unit 50.
export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>({ step: "loading" }),
    [client, setClient] = useState<SupabaseClient | null>(null);
  useEffect(() => {
    let live = true;
    // The server has the final say: a valid sign-in is not enough on its own.
    async function admit() {
      try {
        const me = await api<{ email: string }>("/me");
        if (live) setState({ step: "signed-in", email: me.email });
      } catch (e) {
        await signOut();
        // A new attempt number remounts the form, so it shows this message.
        if (live)
          setState({
            step: "signed-out",
            message: (e as Error).message,
            attempt: Date.now(),
          });
      }
    }
    let unsubscribe = () => {};
    initAuth()
      .then(async (supabase) => {
        if (!live) return;
        if (!supabase) return setState({ step: "open" });
        setClient(supabase);
        const { data } = await supabase.auth.getSession();
        if (!live) return;
        if (data.session) await admit();
        else setState({ step: "signed-out" });
        const { data: listener } = supabase.auth.onAuthStateChange((event) => {
          if (!live) return;
          if (event === "SIGNED_IN") void admit();
          if (event === "SIGNED_OUT")
            setState((s) =>
              s.step === "signed-out" ? s : { step: "signed-out" },
            );
        });
        unsubscribe = () => listener.subscription.unsubscribe();
      })
      .catch((e) => {
        if (live) setState({ step: "failed", message: (e as Error).message });
      });
    // A rejected request (expired or disabled account) returns to the sign-in screen.
    const onRejected = () => void signOut();
    window.addEventListener("unit50:signed-out", onRejected);
    return () => {
      live = false;
      unsubscribe();
      window.removeEventListener("unit50:signed-out", onRejected);
    };
  }, []);
  if (state.step === "loading")
    return (
      <div className="auth-screen" role="status">
        <p className="auth-wait">Loading…</p>
      </div>
    );
  if (state.step === "failed")
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <Brand />
          <div className="form-error" role="alert">
            {state.message} Reload the page to try again.
          </div>
        </div>
      </div>
    );
  if (state.step === "signed-out")
    return (
      <SignIn key={state.attempt} client={client!} message={state.message} />
    );
  return (
    <Account.Provider
      value={{
        email: state.step === "signed-in" ? state.email : null,
        signOut: client ? () => void signOut() : null,
      }}
    >
      {children}
    </Account.Provider>
  );
}
function Brand() {
  return (
    <div className="auth-brand">
      <span className="brand-symbol">
        <House size={27} strokeWidth={1.7} />
      </span>
      <span>
        UNIT <b>50</b>
        <small>FIELDWORK</small>
      </span>
    </div>
  );
}
function SignIn({
  client,
  message,
}: {
  client: SupabaseClient;
  message?: string;
}) {
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(message || "");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { error: failure } = await client.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    // On success the gate takes over through the SIGNED_IN event.
    if (failure) {
      setError(
        failure.status === 400
          ? "The email or password is not correct."
          : failure.message || "Sign-in failed. Try again.",
      );
      setBusy(false);
    }
  }
  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={(e) => void submit(e)}>
        <Brand />
        <h1>Sign in</h1>
        <p>Use the account your administrator created for you.</p>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <label>
          Email
          <input
            type="email"
            autoComplete="username"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button className="primary-button full" disabled={busy}>
          <LogIn size={17} />
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
