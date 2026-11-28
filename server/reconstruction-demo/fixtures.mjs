export const styles = [
  { id: 'original', name: '跟随原片', image: 'cinematic', description: '沿用参考片的画面风格' },
  { id: 'comic', name: '美式漫画', image: 'graphic-comic', description: '墨线、网点与高对比' },
  { id: 'cinema', name: '写实电影', image: 'cinematic', description: '真人质感与电影光影' },
  { id: 'anime', name: '日系动画', image: 'cel-anime', description: '清晰线条与赛璐璐上色' },
  { id: '3d', name: '3D 动画', image: '3d-fantasy', description: '立体造型与柔和材质' },
  { id: 'watercolor', name: '水彩插画', image: 'watercolor', description: '纸面纹理与柔和晕染' },
];

// Local simulation catalog for the picker UI. Every entry renders a local fixture and costs nothing.
// When ported to the main site this list must come from the site's enabled image/video channel models.
export const generationModels = {
  image: [
    { id: 'jimeng-image-3', name: '即梦 图片 3.0', tag: '推荐', description: '中文语义理解强，人像质感细腻', counts: [1, 2, 4], defaultCount: 4 },
    { id: 'nano-banana', name: 'Nano Banana', tag: '角色一致', description: '多参考图融合，跨镜头人物不走样', counts: [1, 2, 4], defaultCount: 4 },
    { id: 'gpt-image-1', name: 'GPT-Image-1', tag: '', description: '复杂构图与画面细节还原', counts: [1, 2, 4], defaultCount: 2 },
    { id: 'flux-kontext-pro', name: 'FLUX Kontext Pro', tag: '', description: '风格迁移与局部重绘', counts: [1, 2, 4], defaultCount: 4 },
  ],
  video: [
    { id: 'kling-2-1', name: '可灵 2.1', tag: '推荐', description: '首帧驱动，人物动作自然连贯', counts: [1, 2], defaultCount: 1, resolutions: ['720p', '1080p'], allowedSeconds: [5, 10] },
    { id: 'hailuo-02', name: '海螺 02', tag: '运镜', description: '大幅运镜与物理效果表现好', counts: [1, 2], defaultCount: 1, resolutions: ['768p', '1080p'], allowedSeconds: [6, 10] },
    { id: 'seedance-1-pro', name: 'Seedance 1.0 Pro', tag: '', description: '多镜头叙事与画面稳定', counts: [1, 2], defaultCount: 1, resolutions: ['720p', '1080p'], allowedSeconds: [4, 5, 6, 7, 8, 9, 10, 11, 12] },
    { id: 'veo-3-fast', name: 'Veo 3 Fast', tag: '', description: '电影级光影，生成速度快', counts: [1, 2], defaultCount: 1, resolutions: ['720p', '1080p'], allowedSeconds: [4, 6, 8] },
  ],
};

export const cameraMovements = [
  { id: 'auto', name: '跟随原片', short: '跟随原片', promptHint: '' },
  { id: 'static', name: '固定镜头', short: '固定', promptHint: '固定机位，画面稳定不动' },
  { id: 'push_in', name: '缓慢推近', short: '推近', promptHint: '镜头缓慢向前推进聚焦主体' },
  { id: 'pull_out', name: '缓慢拉远', short: '拉远', promptHint: '镜头缓慢向后拉远展现环境' },
  { id: 'pan_left', name: '左摇 / 左移', short: '左摇', promptHint: '镜头平滑向左摇移扫视画面' },
  { id: 'pan_right', name: '右摇 / 右移', short: '右摇', promptHint: '镜头平滑向右摇移扫视画面' },
  { id: 'tilt_up', name: '上摇 / 上升', short: '上升', promptHint: '镜头缓慢向上仰摇抬升' },
  { id: 'tilt_down', name: '下摇 / 下降', short: '下降', promptHint: '镜头缓慢向下俯摇下降' },
  { id: 'orbit', name: '环绕运镜', short: '环绕', promptHint: '镜头围绕主体平滑弧线环绕' },
  { id: 'follow', name: '跟拍跟随', short: '跟拍', promptHint: '镜头紧随主体移动方向同步跟拍' },
  { id: 'handheld', name: '手持微晃', short: '手持', promptHint: '纪实手持镜头，带自然轻微呼吸晃动' },
  { id: 'dolly_zoom', name: '希区柯克变焦', short: '希区柯克', promptHint: '希区柯克滑动变焦，主体大小不变背景压缩拉远' },
];

export const aspectRatios = [
  { id: '9:16', name: '9:16 竖屏', width: 720, height: 1280, description: '抖音 / 小红书 / 快手短视频与竖屏短剧' },
  { id: '16:9', name: '16:9 横屏', width: 1280, height: 720, description: 'B 站 / YouTube / 横屏漫剧与宣传片' },
  { id: '1:1', name: '1:1 方屏', width: 960, height: 960, description: '电商主图视频与信息流方形卡片' },
];

export const audioModes = [
  { id: 'original', name: '保留原片音轨', description: '成片合成时自动对齐并混入原参考视频的背景音与环境声' },
  { id: 'mute', name: '静音（仅内封字幕）', description: '输出纯静音音轨与软字幕，便于后期自行配乐' },
];

// This deterministic response stands in for Gemini. It does not infer any uploaded video's content.
export function mockAnalysis(preset = '') {
  if (preset === 'duo') {
    return {
      title: '雨夜来信（双人对手戏）', duration: 15,
      hook: '双人交接牛皮信封引出悬念，女主门前回望，送信人转身没入雨巷。',
      continuity: '雨后街巷，右侧暖色门灯与冷蓝色街道光线，双人物装束与雨景保持连贯。',
      characters: [
        { id: 'ning', kind: 'person', name: '阿宁', appearance: '齐肩黑发，米色风衣、深绿针织衫，手持牛皮信封。' },
        { id: 'chen', kind: 'person', name: '陈默（送信人）', appearance: '短黑发，深灰毛呢大衣、黑色围巾，斜挎复古皮质邮包。' },
      ],
      shots: [
        { id: '01', start: 0, end: 3, title: '信封交接特写', characters: ['ning', 'chen'],
          scene: '雨夜老街 · 门口（外景/夜）',
          action: '细雨落下，陈默将一封边角微湿的牛皮信封递到阿宁手中。阿宁双手接过并收紧指尖，右侧暖色门灯照亮两人袖口，陈默随即松手后退半步。',
          speaker: '旁白',
          audio: '细雨沙沙声、纸张摩擦轻响、低沉钢琴单音',
          camera: 'push_in',
          framePrompt: '双人近景特写。陈默将牛皮信封递给阿宁，阿宁双手接过信封居中，右侧暖灯照亮两人袖口。',
          videoPrompt: '镜头缓慢推近。雨滴沿信封滑落，陈默松手后退半步，阿宁收紧指尖停在湿透的信角。',
          caption: '一封迟到的信', crop: { left: 560, top: 420, width: 660, height: 540 } },
        { id: '02', start: 3, end: 8, title: '门前回望', characters: ['ning'],
          scene: '雨夜老街 · 木门前（外景/夜）',
          action: '阿宁独自停在门前，将信封举到胸前。她微微抬眼望向虚掩的门内，神情若有所思，停顿两秒后垂眸准备拆开信封。',
          speaker: '旁白',
          audio: '远处街道车声渐弱、雨滴敲打屋檐、轻缓弦乐铺底',
          camera: 'tilt_down',
          framePrompt: '半身近景。阿宁独自站在门前，双手把信封举到胸前，右侧门灯亮着。',
          videoPrompt: '阿宁抬眼看向门内，停顿一下再低头拆信。镜头随动作轻轻下移。',
          caption: '她在门口停了一下', crop: { left: 370, top: 60, width: 800, height: 900 } },
        { id: '03', start: 8, end: 15, title: '雨巷离去与门灯', characters: ['chen'],
          scene: '雨夜老街 · 巷口与门灯（外景/夜）',
          action: '前景是带着水痕的木门框与暖色门灯，虚焦的雨巷尽头，身穿深灰大衣的陈默转身走入冷蓝街灯中。门灯轻轻闪烁两下后熄灭，整条街巷陷入寂静。',
          speaker: '旁白',
          audio: '渐远的湿润脚步声、电流轻微滋响、门灯熄灭后的环境留白',
          camera: 'pull_out',
          framePrompt: '暖色门灯与湿润木门框前景，虚焦雨巷中可见陈默穿深灰大衣转身离去的背影。',
          videoPrompt: '镜头缓慢拉远，陈默走入雨巷冷光中，门灯闪烁后熄灭，街道归于安静。',
          caption: '门内突然安静了', crop: { left: 1180, top: 0, width: 350, height: 740 } },
      ],
    };
  }
  return {
    title: '雨夜来信', duration: 15,
    hook: '信封特写引出悬念，人物回望，再用熄灭的门灯收尾。',
    continuity: '雨后街巷，右侧暖色门灯与冷蓝色街道光线。',
    characters: [{ id: 'ning', kind: 'person', name: '阿宁', appearance: '齐肩黑发，米色风衣、深绿针织衫，手持牛皮信封。' }],
    shots: [
      { id: '01', start: 0, end: 3, title: '信封特写', characters: ['ning'],
        scene: '雨夜老街 · 门口（外景/夜）',
        action: '阿宁双手紧握一封被雨水打湿边角的牛皮信封，一滴雨顺着信封滑落，暖色门灯映亮米色风衣袖口。',
        speaker: '旁白',
        audio: '细雨声、纸张轻响、低沉钢琴单音',
        camera: 'push_in',
        framePrompt: '手部特写。阿宁双手握住牛皮信封，信封居中，右侧暖灯照亮米色袖口。',
        videoPrompt: '镜头缓慢推近。一滴雨沿信封滑落，阿宁收紧指尖，最后停在湿透的信角。',
        caption: '一封迟到的信', crop: { left: 560, top: 420, width: 660, height: 540 } },
      { id: '02', start: 3, end: 8, title: '门前回望', characters: ['ning'],
        scene: '雨夜老街 · 木门前（外景/夜）',
        action: '阿宁站在门前，双手将信封举到胸前，抬眼望向门内停顿片刻，随后低头拆信。',
        speaker: '旁白',
        audio: '雨滴敲打屋檐、轻缓弦乐铺底',
        camera: 'tilt_down',
        framePrompt: '半身近景。阿宁在门前，双手把信封举到胸前，右侧门灯亮着。',
        videoPrompt: '阿宁抬眼看向门内，停顿一下再低头拆信。镜头随动作轻轻下移。',
        caption: '她在门口停了一下', crop: { left: 370, top: 60, width: 800, height: 900 } },
      { id: '03', start: 8, end: 15, title: '门灯空镜', characters: [],
        scene: '雨夜老街 · 门灯特写（外景/夜）',
        action: '带水痕的木门框与暖色门灯特写，镜头缓慢拉远，门灯闪烁后彻底熄灭，雨巷只剩冷蓝街光。',
        speaker: '旁白',
        audio: '电流轻响、雨声渐静',
        camera: 'pull_out',
        framePrompt: '暖色门灯与带水痕的木门框特写，画面无人，背景是虚焦的雨巷。',
        videoPrompt: '门灯特写缓慢拉远，光线闪烁后熄灭，画面留在街道的冷光中。',
        caption: '门内突然安静了', crop: { left: 1180, top: 0, width: 350, height: 740 } },
    ],
  };
}
