export const copywritingPlatforms = { generic: '通用详情页', taobao: '淘宝 / 天猫', amazon: 'Amazon', tiktok: 'TikTok Shop', shopify: '独立站' };
export const copywritingLanguages = { 'zh-CN': '简体中文', en: 'English' };
export type CopywritingOptions = {
  mode: 'marketing' | 'detail'; platform: keyof typeof copywritingPlatforms; language: keyof typeof copywritingLanguages;
  productName: string; audience: string; productFacts: string; factsConfirmed: boolean;
};
export type ProductDetailCopy = {
  title: string; subtitle: string;
  sections: Array<{ heading: string; body: string; bullets: string[] }>;
  specifications: Array<{ name: string; value: string }>;
  faqs: Array<{ question: string; answer: string }>;
  factsToConfirm: string[];
};
export const defaultCopywritingOptions: CopywritingOptions = {
  mode: 'marketing', platform: 'generic', language: 'zh-CN', productName: '', audience: '', productFacts: '', factsConfirmed: false,
};

export function parseCopywritingOptions(input?: unknown): CopywritingOptions {
  if (input === undefined || input === '') return { ...defaultCopywritingOptions };
  const fail = (message: string): never => { throw Object.assign(new Error(message), { status: 400 }); };
  let value: any = input;
  if (typeof input === 'string') {
    if (input.length > 10_000) fail('产品信息过长');
    try { value = JSON.parse(input); } catch { fail('文案设置格式无效'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('文案设置格式无效');
  const options = { ...defaultCopywritingOptions };
  for (const key of ['mode', 'platform', 'language'] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'string') fail('文案模式、平台或语言无效');
      const valid = key === 'mode' ? ['marketing', 'detail'].includes(value[key])
        : Object.hasOwn(key === 'platform' ? copywritingPlatforms : copywritingLanguages, value[key]);
      if (!valid) fail('文案模式、平台或语言无效');
      (options as any)[key] = value[key];
    }
  }
  for (const [key, max] of [['productName', 120], ['audience', 300], ['productFacts', 3000]] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') fail('产品信息须为文本');
    const text = (value[key] || '').trim();
    if (text.length > max) fail(`产品信息超过 ${max} 字限制`);
    options[key] = text;
  }
  options.factsConfirmed = value.factsConfirmed === true;
  if (options.productFacts && !options.factsConfirmed) fail('请先确认补充的产品信息已核实');
  return options;
}

export function isProductDetailCopy(value: any): value is ProductDetailCopy {
  const text = (v: unknown, max = 6000) => typeof v === 'string' && v.length <= max;
  const texts = (v: unknown, max: number) => Array.isArray(v) && v.length <= max && v.every(item => text(item, 2000));
  return Boolean(value && text(value.title, 300) && value.title.trim() && text(value.subtitle, 600)
    && Array.isArray(value.sections) && value.sections.length >= 1 && value.sections.length <= 10
    && value.sections.every(section => section && text(section.heading, 300) && section.heading.trim() && text(section.body) && texts(section.bullets, 10)
      && (section.body.trim() || section.bullets.some(text => text.trim())))
    && Array.isArray(value.specifications) && value.specifications.length <= 20
    && value.specifications.every(spec => spec && text(spec.name, 120) && spec.name.trim() && text(spec.value, 1000) && spec.value.trim())
    && Array.isArray(value.faqs) && value.faqs.length <= 10
    && value.faqs.every(faq => faq && text(faq.question, 500) && faq.question.trim() && text(faq.answer, 3000) && faq.answer.trim())
    && texts(value.factsToConfirm, 20) && JSON.stringify(value).length <= 120_000);
}

/** Exports the current edited document, rather than an earlier model response. */
export function formatProductDetail(detail: ProductDetailCopy, format: 'md' | 'txt' = 'md', language: CopywritingOptions['language'] = 'zh-CN'): string {
  const heading = (value: string, level: number) => `${format === 'md' ? '#'.repeat(level) + ' ' : ''}${value}`;
  const english = language === 'en';
  const blocks = [heading(detail.title, 1), detail.subtitle];
  for (const section of detail.sections) blocks.push(heading(section.heading, 2), section.body, section.bullets.map(text => `- ${text}`).join('\n'));
  if (detail.specifications.length) blocks.push(heading(english ? 'Specifications' : '产品规格', 2), detail.specifications.map(spec => `${spec.name}: ${spec.value}`).join('\n'));
  if (detail.faqs.length) blocks.push(heading(english ? 'FAQ' : '常见问题', 2), detail.faqs.map(faq => `${faq.question}\n${faq.answer}`).join('\n\n'));
  if (detail.factsToConfirm.length) blocks.push(heading(english ? 'Needs confirmation' : '待确认信息', 2), detail.factsToConfirm.map(text => `- ${text}`).join('\n'));
  return blocks.filter(Boolean).join('\n\n') + '\n';
}
