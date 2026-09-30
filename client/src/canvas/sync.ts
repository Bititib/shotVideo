import { api } from '../api/client';
import { parseDocument, uid, type Workspace } from './model';

export type CloudWorkspace = { revision: number; workspace: Workspace };
export const fetchCloudWorkspace = () => api.get<CloudWorkspace>('/canvas/workspace');
export async function saveCloudWorkspace(workspace: Workspace) {
  const migrated = structuredClone(workspace);
  const uploaded = new Map<string,string>();
  const store = async (src: string|undefined, filename: string) => {
    if (!src?.startsWith('data:')) return src;
    if (uploaded.has(src)) return uploaded.get(src)!;
    const media = await api.post<{url:string}>('/media', {dataUrl:src,filename}, {timeoutMs:120000});
    uploaded.set(src,media.url); return media.url;
  };
  for (const project of migrated.projects) for (const node of project.nodes) {
    node.src = await store(node.src,node.title);
    for (const version of node.versions||[]) version.src = (await store(version.src,node.title))!;
  }
  const result = await api.put<{revision:number}>('/canvas/workspace',{revision:workspace.cloudRevision??0,workspace:migrated});
  return {...result,workspace:migrated};
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
