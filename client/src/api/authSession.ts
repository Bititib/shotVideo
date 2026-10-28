// Each response belongs to the session that sent it, not whichever user is
// signed in when the response eventually arrives.
let revision = 0;
const invalidationListeners = new Set<() => void>();

export function getAuthSession() {
  return { token: localStorage.getItem('token'), revision };
}

export function isCurrentAuthSession(session: ReturnType<typeof getAuthSession>) {
  return session.revision === revision && session.token === localStorage.getItem('token');
}

export function saveAuthToken(token: string) {
  localStorage.setItem('token', token);
  revision += 1;
  return getAuthSession();
}

export function invalidateAuthSession(session = getAuthSession()) {
  if (!isCurrentAuthSession(session)) return;
  localStorage.removeItem('token');
  revision += 1;
  invalidationListeners.forEach(listener => listener());
}

export function onAuthSessionInvalidated(listener: () => void) {
  invalidationListeners.add(listener);
  return () => { invalidationListeners.delete(listener); };
}
