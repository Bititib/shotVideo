import { api } from '../api/client';
import { parseDocument, uid, type Workspace } from './model';

export type CloudWorkspace = { revision: number; workspace: Workspace };
export const fetchCloudWorkspace = () => api.get<CloudWorkspace>('/canvas/workspace');
export async function saveCloudWorkspace(workspace: Workspace, signal?: AbortSignal) {
  const sessionToken = typeof localStorage === 'undefined' ? null : localStorage.getItem('token');
  const assertActive = () => {
    signal?.throwIfAborted();
    if (typeof localStorage !== 'undefined' && localStorage.getItem('token') !== sessionToken) {
      throw new Error('登录状态已变化，画布已保留在本地，请重新同步');
    }
  };
  assertActive();
  const migrated = structuredClone(workspace);
  const uploaded = new Map<string,string>();
  const store = async (src: string|undefined, filename: string) => {
    assertActive();
    if (!src?.startsWith('data:')) return src;
    if (uploaded.has(src)) return uploaded.get(src)!;
    const media = await api.post<{url:string}>('/media', {dataUrl:src,filename}, {timeoutMs:120000, signal});
    assertActive();
    uploaded.set(src,media.url); return media.url;
  };
  for (const project of migrated.projects) for (const node of project.nodes) {
    node.src = await store(node.src,node.title);
    for (const version of node.versions||[]) version.src = (await store(version.src,node.title))!;
  }
  assertActive();
  const body = {revision:workspace.cloudRevision??0,workspace:migrated};
  const result = signal ? await api.put<{revision:number}>('/canvas/workspace',body,{signal})
    : await api.put<{revision:number}>('/canvas/workspace',body);
  return {...result,workspace:migrated};
}

// Merge only proven upload substitutions into the newest edits, never an old layout/draft.
export function mergeUploadedMedia(current: Workspace, submitted: Workspace, migrated?: Workspace): Workspace {
  if (!migrated) return current;
  const replacements = new Map<string, string>();
  const originalProjects = new Map(submitted.projects.map(project => [project.id, project]));
  const remember = (before?: string, after?: string) => {
    if (before?.startsWith('data:') && after?.startsWith('/api/media/')) replacements.set(before, after);
  };
  for (const project of migrated.projects) {
    const original = originalProjects.get(project.id);
    if (!original) continue;
    const nodes = new Map(original.nodes.map(node => [node.id, node]));
    for (const node of project.nodes) {
      const before = nodes.get(node.id);
      if (!before) continue;
      remember(before.src, node.src);
      const versions = new Map(before.versions?.map(version => [version.id, version]));
      for (const version of node.versions || []) remember(versions.get(version.id)?.src, version.src);
    }
  }
  if (!replacements.size) return current;
  let changed = false;
  const projects = current.projects.map(project => {
    let projectChanged = false;
    const nodes = project.nodes.map(node => {
      const src = node.src && replacements.get(node.src) || node.src;
      let versionsChanged = false;
      const versions = node.versions?.map(version => {
        const next = replacements.get(version.src);
        if (!next) return version;
        versionsChanged = true; return {...version, src:next};
      });
      if (src === node.src && !versionsChanged) return node;
      projectChanged = true; return {...node, src, versions};
    });
    if (!projectChanged) return project;
    changed = true; return {...project, nodes};
  });
  return changed ? {...current, projects} : current;
}

// Never choose a winner by clock time: offline edits and clock skew must not lose work.
export function reconcileWorkspace(local: Workspace, cloud: CloudWorkspace): Workspace {
  if (!cloud.revision) return { ...local, cloudRevision: 0, cloudPending: true };
  const remote = cloud.workspace.projects.map(parseDocument);
  if (local.cloudRevision === cloud.revision) return { ...local, cloudRevision: cloud.revision };
  const pending = local.cloudPending !== false;
  let activeId = remote.some(p => p.id === local.activeId) ? local.activeId : cloud.workspace.activeId;
  if (pending) for (const project of local.projects) {
    if (!local.cloudRevision && !project.nodes.length && project.title === '我的灵感画布') continue;
    const other = remote.find(p => p.id === project.id);
    if (!other) { remote.push(project); if (project.id === local.activeId) activeId = project.id; }
    else if (JSON.stringify(other) !== JSON.stringify(parseDocument(project))) {
      const copy = { ...project, id: uid(), title: `${project.title.slice(0, 60)}（本地保留版）` };
      remote.push(copy); if (project.id === local.activeId) activeId = copy.id;
    }
  }
  return { version: 2, activeId: activeId || remote[0].id, projects: remote, cloudRevision: cloud.revision, cloudPending: pending };
}
