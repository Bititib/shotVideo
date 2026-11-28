import { validatePlan } from './gemini-analysis.mjs';

const SCENE_HEADER_RE = /^(?:\*{0,2})【\s*(?:第\s*\d+\s*[场幕镜]|Scene\s*\d+|镜头\s*\d+)(?:\s*[｜|：:\-—]\s*([^】]*))?\s*】(?:\*{0,2})$|^(?:第\s*\d+\s*[场幕镜]|Scene\s*\d+|镜头\s*\d+)(?:\s*[｜|：:\-—]\s*(.*))?$/i;
const TIME_BLOCK_HEADER_RE = /^(?:\*{0,2})【\s*((?:\d{1,3}:\d{2}|\d+(?:\.\d+)?\s*s?)\s*[-~—–至]+\s*(?:\d{1,3}:\d{2}|\d+(?:\.\d+)?\s*s?))\s*】\s*(.*?)(?:\*{0,2})$/i;
const MARKDOWN_HEADING_RE = /^(#{1,6})\s+(.+)$/;
const FIELD_RE = /^(出镜|人物|角色|场景|画面|特效画面[^：:]*|动作|音效|BGM|声音|配乐|旁白|对白|台词|景别|运镜|景别\s*\/\s*运镜)\s*[：:]\s*(.*)$/i;
const SPEAKER_LINE_RE = /^([^：:\n]{1,40})\s*[：:]\s*(.*)$/;

function stripMd(text) {
  return String(text || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

function parseTimeToken(token) {
  const s = String(token || '').trim();
  const mmss = s.match(/^(\d{1,3}):(\d{2})$/);
  if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2]);
  const sec = s.match(/^(\d+(?:\.\d+)?)\s*s?$/i);
  if (sec) return Number(sec[1]);
  return NaN;
}

function parseTimeRange(text) {
  if (!text) return null;
  const m = String(text).match(/(\d{1,3}:\d{2}|\d+(?:\.\d+)?\s*s?)\s*[-~—–至]+\s*(\d{1,3}:\d{2}|\d+(?:\.\d+)?\s*s?)/i);
  if (!m) return null;
  const start = parseTimeToken(m[1]);
  const end = parseTimeToken(m[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

function detectCamera(text) {
  const s = String(text || '').toLowerCase();
  if (!s) return 'static';
  if (/希区柯克|dolly\s*zoom/.test(s)) return 'dolly_zoom';
  if (/环绕|orbit/.test(s)) return 'orbit';
  if (/推近|推进|push/.test(s)) return 'push_in';
  if (/拉远|拉出|pull/.test(s)) return 'pull_out';
  if (/左摇|左移|pan\s*left/.test(s)) return 'pan_left';
  if (/右摇|右移|pan\s*right/.test(s)) return 'pan_right';
  if (/上摇|上升|tilt\s*up/.test(s)) return 'tilt_up';
  if (/下摇|下降|俯摇|tilt\s*down/.test(s)) return 'tilt_down';
  if (/跟拍|跟随|follow/.test(s)) return 'follow';
  if (/手持|handheld/.test(s)) return 'handheld';
  return 'static';
}

export function resolveModelDurationRule(options = {}) {
  const rawAllowed = Array.isArray(options.allowedSeconds)
    ? options.allowedSeconds.map(Number).filter(n => Number.isFinite(n) && n > 0)
    : [];
  const allowedSeconds = [...new Set(rawAllowed)].sort((a, b) => a - b);
  const maxDuration = allowedSeconds.length
    ? allowedSeconds[allowedSeconds.length - 1]
    : (Number(options.maxDuration) > 0 ? Number(options.maxDuration) : 10);
  const minDuration = allowedSeconds.length
    ? allowedSeconds[0]
    : (Number(options.minDuration) > 0 ? Number(options.minDuration) : 1);
  const defaultDuration = allowedSeconds.length
    ? (allowedSeconds.includes(5) ? 5 : allowedSeconds[0])
    : (Number(options.defaultDuration) > 0 ? Math.min(maxDuration, Number(options.defaultDuration)) : Math.min(5, maxDuration));

  const snap = target => {
    const t = Number(target);
    if (!Number.isFinite(t) || t <= 0) return defaultDuration;
    if (allowedSeconds.length) {
      const ge = allowedSeconds.find(v => v >= t - 0.05);
      return ge !== undefined ? ge : maxDuration;
    }
    return Number(Math.max(minDuration, Math.min(maxDuration, t)).toFixed(2));
  };

  return { allowedSeconds, minDuration, maxDuration, defaultDuration, snap };
}

function splitDurationForModel(rawDur, rule) {
  if (rawDur <= rule.maxDuration + 0.05) {
    return [rule.snap(rawDur)];
  }
  const count = Math.max(2, Math.ceil(rawDur / rule.maxDuration));
  const avg = rawDur / count;
  const durations = [];
  for (let i = 0; i < count; i++) {
    durations.push(rule.snap(avg));
  }
  return durations;
}

function parseCharacterTable(lines) {
  const roles = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.startsWith('|') && i + 1 < lines.length && /^\|\s*:?-{2,}/.test(lines[i + 1].trim())) {
      const headers = line.split('|').slice(1, -1).map(c => stripMd(c));
      const headerText = headers.join(' ');
      if (/角色|人物|名称|主体|name/i.test(headerText)) {
        i += 2;
        while (i < lines.length && lines[i].trim().startsWith('|')) {
          const cols = lines[i].trim().split('|').slice(1, -1).map(c => stripMd(c));
          const name = (cols[0] || '').trim();
          if (name) {
            const details = cols.slice(1).filter(Boolean).join('；');
            const kind = /产品|商品|道具|爆珠|薄荷珠|瓶|盒|product/i.test(`${name} ${details}`) ? 'product' : 'person';
            roles.push({
              name,
              kind,
              appearance: (details || `${name}，保持角色外观、服饰与质感一致`).slice(0, 2000),
            });
          }
          i++;
        }
        continue;
      }
    }
    i++;
  }
  return roles;
}

function matchCharacterName(rawName, roleList) {
  const clean = stripMd(rawName);
  if (!clean) return null;
  const exact = roleList.find(r => r.name === clean);
  if (exact) return exact;
  const baseClean = clean.replace(/[（(][^）)]*[）)]/g, '').trim().toLowerCase();
  return roleList.find(r => {
    const rBase = r.name.replace(/[（(][^）)]*[）)]/g, '').trim().toLowerCase();
    return rBase && (rBase === baseClean || r.name.toLowerCase().includes(clean.toLowerCase()) || clean.toLowerCase().includes(rBase));
  }) || null;
}

function distributeItems(items, count) {
  if (count <= 1) return [items];
  const buckets = Array.from({ length: count }, () => []);
  items.forEach((item, idx) => {
    const bucketIdx = Math.min(count - 1, Math.floor((idx * count) / Math.max(1, items.length)));
    buckets[bucketIdx].push(item);
  });
  return buckets;
}

export function parsePlainScriptToPlan(rawText, options = {}) {
  const text = String(rawText || '').replace(/\r\n/g, '\n').trim();
  if (!text) throw new Error('请输入剧本文本后再导入');

  const lines = text.split('\n');
  const rule = resolveModelDurationRule(options);

  let title = stripMd(options.title || '');
  let hook = '';
  let continuity = '';
  let currentAct = '';
  const tableRoles = parseCharacterTable(lines);

  const shotDrafts = [];
  let current = null;
  let lastSpeaker = '';

  const flush = () => {
    if (!current) return;
    if (
      current.visual.length ||
      current.dialogueTurns.length ||
      current.scene ||
      current.action ||
      current.audio
    ) {
      shotDrafts.push(current);
    }
    current = null;
    lastSpeaker = '';
  };

  const ensureCurrent = (label = '', timeRange = null) => {
    if (!current) {
      current = {
        label: label || currentAct || `第 ${shotDrafts.length + 1} 场`,
        act: currentAct,
        timeRange,
        roles: [],
        scene: '',
        action: '',
        visual: [],
        audio: '',
        camera: '',
        dialogueTurns: [],
      };
    }
    return current;
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i].trim();
    if (!rawLine) {
      lastSpeaker = '';
      continue;
    }
    if (/^[-*_]{3,}$/.test(rawLine)) {
      lastSpeaker = '';
      continue;
    }
    if (rawLine.startsWith('|')) continue;

    const mdHeading = rawLine.match(MARKDOWN_HEADING_RE);
    if (mdHeading) {
      const level = mdHeading[1].length;
      const headingText = stripMd(mdHeading[2]);
      if (level === 1 && !title) {
        title = headingText.replace(/^剧本[：:]\s*/, '').slice(0, 120);
        continue;
      }
      const tr = parseTimeRange(headingText);
      if (tr) {
        flush();
        ensureCurrent(headingText, tr);
        continue;
      }
      if (/人物|角色|设定/i.test(headingText)) {
        lastSpeaker = '';
        continue;
      }
      currentAct = headingText;
      lastSpeaker = '';
      continue;
    }

    const titleMatch = stripMd(rawLine).match(/^(?:片名|标题|剧名)\s*[：:]\s*(.+)$/);
    if (titleMatch && !title && !current) {
      title = titleMatch[1].trim().slice(0, 120);
      continue;
    }
    const hookMatch = stripMd(rawLine).match(/^(?:钩子|核心卖点|开篇钩子|Hook)\s*[：:]\s*(.+)$/i);
    if (hookMatch && !current) {
      hook = hookMatch[1].trim().slice(0, 1200);
      continue;
    }
    const styleMatch = stripMd(rawLine).match(/^(?:视觉风格|画风|连续性|Continuity)\s*[：:]\s*(.+)$/i);
    if (styleMatch && !current) {
      continuity = styleMatch[1].trim().slice(0, 1200);
      continue;
    }

    const timeHeader = rawLine.match(TIME_BLOCK_HEADER_RE);
    if (timeHeader) {
      const tr = parseTimeRange(timeHeader[1]);
      const label = stripMd(timeHeader[2] || timeHeader[1]).slice(0, 120);
      flush();
      ensureCurrent(label, tr);
      continue;
    }

    const sceneHeader = rawLine.match(SCENE_HEADER_RE);
    if (sceneHeader) {
      const extra = stripMd(sceneHeader[1] || sceneHeader[2] || '');
      const tr = parseTimeRange(extra);
      flush();
      ensureCurrent(extra.replace(/(\d{1,3}:\d{2}|\d+(?:\.\d+)?s?)\s*[-~—–至]+\s*(\d{1,3}:\d{2}|\d+(?:\.\d+)?s?)/gi, '').trim() || stripMd(rawLine), tr);
      continue;
    }

    // Blockquote lines (> "..." or > （中文）) attached to previous speaker
    if (rawLine.startsWith('>')) {
      const quoteText = stripMd(rawLine.replace(/^>+\s*/, ''));
      if (quoteText && current) {
        if (lastSpeaker && current.dialogueTurns.length) {
          const prev = current.dialogueTurns[current.dialogueTurns.length - 1];
          if (prev.speaker === lastSpeaker) {
            prev.text = prev.text ? `${prev.text} ${quoteText}` : quoteText;
            continue;
          }
        }
        current.dialogueTurns.push({ speaker: lastSpeaker || '旁白', text: quoteText });
      }
      continue;
    }

    const cleanBullet = stripMd(rawLine.replace(/^[*\-•]\s+/, ''));
    const field = cleanBullet.match(FIELD_RE);
    if (field) {
      const target = ensureCurrent();
      const key = field[1].toLowerCase();
      const val = field[2].trim();
      lastSpeaker = '';
      if (/^(出镜|人物|角色)$/.test(key)) {
        val.split(/[、,，/]+/).map(s => s.trim()).filter(Boolean).forEach(r => target.roles.push(r));
      } else if (key === '场景') {
        target.scene = target.scene ? `${target.scene}；${val}` : val;
      } else if (key === '动作') {
        target.action = target.action ? `${target.action}；${val}` : val;
      } else if (/^(画面|特效画面)/.test(key)) {
        if (val) target.visual.push(val);
      } else if (/^(景别|运镜)/.test(key)) {
        target.camera = `${target.camera} ${val}`.trim();
      } else if (/^(音效|bgm|声音|配乐)$/.test(key)) {
        target.audio = target.audio ? `${target.audio}；${val}` : val;
      } else if (/^(旁白|对白|台词)$/.test(key)) {
        target.dialogueTurns.push({ speaker: key === '旁白' ? '旁白' : '', text: val });
        lastSpeaker = key === '旁白' ? '旁白' : '';
      }
      continue;
    }

    const speakerMatch = cleanBullet.match(SPEAKER_LINE_RE);
    if (speakerMatch && !/^https?$/i.test(speakerMatch[1])) {
      const target = ensureCurrent();
      const spk = speakerMatch[1].trim();
      const content = speakerMatch[2].trim();
      if (!/^(旁白|画外音|音效|字幕|旁白\/OS)$/i.test(spk)) {
        target.roles.push(spk);
      }
      target.dialogueTurns.push({ speaker: spk, text: content });
      lastSpeaker = spk;
      continue;
    }

    // Fallback plain prose line
    const target = ensureCurrent();
    if (!target.scene && cleanBullet.length <= 120) target.scene = cleanBullet;
    else target.visual.push(cleanBullet);
  }
  flush();

  // If user pasted raw text without explicit scene headers, split by non-empty paragraphs
  if (shotDrafts.length === 1 && !shotDrafts[0].timeRange && text.split(/\n\s*\n+/).length > 1) {
    const blocks = text.split(/\n\s*\n+/).map(b => b.trim()).filter(Boolean);
    if (blocks.length > 1 && blocks.every(b => !b.startsWith('|') && !b.startsWith('#'))) {
      shotDrafts.length = 0;
      blocks.forEach((blk, idx) => {
        shotDrafts.push({
          label: `第 ${idx + 1} 场`,
          act: '',
          timeRange: null,
          roles: [],
          scene: stripMd(blk).slice(0, 120),
          action: '',
          visual: [stripMd(blk)],
          audio: '',
          camera: '',
          dialogueTurns: [],
        });
      });
    }
  }

  if (!shotDrafts.length) {
    throw new Error('未能从剧本文本中识别出有效分镜内容，请至少填写一段画面描述或台词');
  }

  // Build unified character registry from tableRoles + shot role/speaker mentions
  const mergedRoles = [...tableRoles];
  const ensureRole = rawName => {
    const clean = stripMd(rawName);
    if (!clean || /^(旁白|画外音|音效|字幕|无)$/i.test(clean)) return null;
    const found = matchCharacterName(clean, mergedRoles);
    if (found) return found;
    const created = {
      name: clean,
      kind: /产品|商品|道具|爆珠|薄荷|product/i.test(clean) ? 'product' : 'person',
      appearance: `${clean}，保持角色外貌、服装与风格一致性`,
    };
    mergedRoles.push(created);
    return created;
  };

  for (const s of shotDrafts) {
    s.roles.forEach(r => ensureRole(r));
    s.dialogueTurns.forEach(d => ensureRole(d.speaker));
  }

  const roleEntries = mergedRoles.map((r, idx) => ({
    id: `role_${idx + 1}`,
    kind: r.kind || 'person',
    name: r.name.slice(0, 100),
    appearance: (r.appearance || `${r.name}，保持角色外观一致`).slice(0, 2000),
  }));

  const findRoleId = rawName => {
    const matched = matchCharacterName(rawName, roleEntries);
    return matched ? matched.id : null;
  };

  // Expand each scene draft into 1 or more shots constrained by the selected video model
  const shots = [];
  let cursor = 0;
  for (let idx = 0; idx < shotDrafts.length; idx++) {
    const s = shotDrafts[idx];
    const rawDur = s.timeRange ? Math.max(1, Number((s.timeRange.end - s.timeRange.start).toFixed(2))) : rule.defaultDuration;
    const subDurations = splitDurationForModel(rawDur, rule);
    const subVisuals = distributeItems(s.visual, subDurations.length);
    const subDialogues = distributeItems(s.dialogueTurns, subDurations.length);

    const charIds = [...new Set([
      ...s.roles.map(findRoleId),
      ...s.dialogueTurns.map(d => findRoleId(d.speaker)),
    ].filter(Boolean))];

    for (let subIdx = 0; subIdx < subDurations.length; subIdx++) {
      const dur = subDurations[subIdx];
      const start = Number(cursor.toFixed(2));
      const end = Number((cursor + dur).toFixed(2));
      cursor = end;

      const shotNum = shots.length + 1;
      const id = String(shotNum).padStart(2, '0');
      const vSlice = subVisuals[subIdx].length ? subVisuals[subIdx] : s.visual;
      const dSlice = subDialogues[subIdx];

      const sceneText = (s.scene || (s.act ? `${s.act}` : s.label)).slice(0, 2000);
      const visualText = vSlice.join('；').trim();
      const actionText = (s.action || visualText || sceneText).slice(0, 2000);
      const speakerList = [...new Set(dSlice.map(d => d.speaker).filter(Boolean))];
      const caption = dSlice.map(d => (d.speaker ? `${d.speaker}：${d.text}` : d.text)).filter(Boolean).join(' ').slice(0, 2400);
      const baseTitle = s.label || `镜头 ${id}`;
      const shotTitle = (subDurations.length > 1 ? `${baseTitle} (${subIdx + 1}/${subDurations.length})` : baseTitle).slice(0, 140);

      const framePrompt = [
        sceneText && `场景：${sceneText}`,
        visualText && `画面：${visualText}`,
        charIds.length ? `主体：${charIds.map(cid => roleEntries.find(r => r.id === cid)?.name).filter(Boolean).join('、')}` : '',
      ].filter(Boolean).join('。').slice(0, 2200) || shotTitle;

      const videoPrompt = [
        actionText && `动作与变化：${actionText}`,
        s.camera && `运镜：${s.camera}`,
        caption && `台词/旁白：${caption}`,
        s.audio && `音效：${s.audio}`,
      ].filter(Boolean).join('。').slice(0, 2200) || framePrompt;

      shots.push({
        id,
        start,
        end,
        title: shotTitle,
        characters: charIds,
        scene: sceneText,
        action: actionText,
        speaker: speakerList.join('、').slice(0, 2000),
        audio: (s.audio || '').slice(0, 2000),
        camera: detectCamera(`${s.camera} ${visualText}`),
        framePrompt,
        videoPrompt,
        caption,
      });
    }
  }

  const finalTitle = (title || shotDrafts[0]?.label || '纯剧本创作项目').slice(0, 120);
  const validated = validatePlan({
    title: finalTitle,
    duration: Number(cursor.toFixed(2)),
    hook: hook || `基于剧本《${finalTitle}》拆解（共 ${shots.length} 镜，单镜上限 ${rule.maxDuration}s）`,
    continuity: continuity || '保持角色设定表外观、材质质感与前后场景光影连贯',
    characters: roleEntries,
    shots,
  }, Number(cursor.toFixed(2)));

  return {
    ...validated,
    videoModel: options.videoModel || null,
    durationRule: {
      minDuration: rule.minDuration,
      maxDuration: rule.maxDuration,
      allowedSeconds: rule.allowedSeconds,
    },
  };
}
