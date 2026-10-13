import React from 'react';
import { Plus, X } from 'lucide-react';
import type { ProductDetailCopy } from '../../../shared/copywriting';

export default function CopywritingDetail({ value, editing, onChange }: {
  value: ProductDetailCopy; editing: boolean; onChange: (value: ProductDetailCopy) => void;
}) {
  const field = (label: string, text: string, change: (text: string) => void, rows = 2, maxLength = 6000) => (
    <textarea aria-label={label} value={text} rows={rows} maxLength={maxLength} onChange={event => change(event.target.value)} />
  );
  return (
    <div className="copywriting-detail">
      <header className="cw-document-title">
        {editing ? field('详情页主标题', value.title, title => onChange({ ...value, title }), 2, 300) : <h1>{value.title}</h1>}
        {editing ? field('首屏副标题', value.subtitle, subtitle => onChange({ ...value, subtitle }), 2, 600) : <p>{value.subtitle}</p>}
      </header>
      {value.sections.map((section, index) => {
        const patch = (update: Partial<typeof section>) => onChange({ ...value, sections: value.sections.map((item, i) => i === index ? { ...item, ...update } : item) });
        return <article className="cw-document-section" key={index}>
          <div className="cw-section-heading"><span>{String(index + 1).padStart(2, '0')}</span>
            {editing ? field(`第 ${index + 1} 屏标题`, section.heading, heading => patch({ heading }), 1, 300) : <h2>{section.heading}</h2>}
            {editing && value.sections.length > 1 && <button type="button" className="cw-icon-button" aria-label={`删除第 ${index + 1} 屏`} onClick={() => onChange({ ...value, sections: value.sections.filter((_, i) => i !== index) })}><X size={14} /></button>}
          </div>
          {editing ? field(`第 ${index + 1} 屏正文`, section.body, body => patch({ body }), 4) : <p>{section.body}</p>}
          {editing ? field(`第 ${index + 1} 屏要点，每行一条`, section.bullets.join('\n'), text => patch({ bullets: text.split('\n') }), 3, 20_000)
            : section.bullets.length > 0 && <ul>{section.bullets.map((text, i) => <li key={i}>{text}</li>)}</ul>}
        </article>;
      })}
      {editing && value.sections.length < 10 && <button type="button" className="cw-add-button" onClick={() => onChange({ ...value, sections: [...value.sections, { heading: '新分屏', body: '', bullets: [] }] })}><Plus size={14} />添加分屏</button>}
      {(value.specifications.length > 0 || editing) && <section className="cw-document-section">
        <h2>产品规格</h2>
        <dl className="cw-specifications">{value.specifications.map((spec, index) => <div key={index}>
          {editing ? <>
            <input aria-label={`规格 ${index + 1} 名称`} value={spec.name} maxLength={120} onChange={event => onChange({ ...value, specifications: value.specifications.map((item, i) => i === index ? { ...item, name: event.target.value } : item) })} />
            <input aria-label={`规格 ${index + 1} 内容`} value={spec.value} maxLength={1000} onChange={event => onChange({ ...value, specifications: value.specifications.map((item, i) => i === index ? { ...item, value: event.target.value } : item) })} />
            <button type="button" className="cw-icon-button" aria-label={`删除规格 ${index + 1}`} onClick={() => onChange({ ...value, specifications: value.specifications.filter((_, i) => i !== index) })}><X size={14} /></button>
          </> : <><dt>{spec.name}</dt><dd>{spec.value}</dd></>}
        </div>)}</dl>
        {editing && value.specifications.length < 20 && <button type="button" className="cw-add-button" onClick={() => onChange({ ...value, specifications: [...value.specifications, { name: '', value: '' }] })}><Plus size={14} />添加规格</button>}
      </section>}
      {(value.faqs.length > 0 || editing) && <section className="cw-document-section">
        <h2>常见问题</h2>
        {value.faqs.map((faq, index) => <div className="cw-faq" key={index}>
          {editing ? <>
            {field(`问题 ${index + 1}`, faq.question, question => onChange({ ...value, faqs: value.faqs.map((item, i) => i === index ? { ...item, question } : item) }), 2, 500)}
            {field(`回答 ${index + 1}`, faq.answer, answer => onChange({ ...value, faqs: value.faqs.map((item, i) => i === index ? { ...item, answer } : item) }), 3, 3000)}
            <button type="button" className="cw-add-button" onClick={() => onChange({ ...value, faqs: value.faqs.filter((_, i) => i !== index) })}>删除此问答</button>
          </> : <><h3>{faq.question}</h3><p>{faq.answer}</p></>}
        </div>)}
        {editing && value.faqs.length < 10 && <button type="button" className="cw-add-button" onClick={() => onChange({ ...value, faqs: [...value.faqs, { question: '', answer: '' }] })}><Plus size={14} />添加问答</button>}
      </section>}
      {(value.factsToConfirm.length > 0 || editing) && <details className="cw-confirmations" open>
        <summary>待确认信息 · {value.factsToConfirm.length}</summary>
        {editing ? field('待确认信息，每行一条', value.factsToConfirm.join('\n'), text => onChange({ ...value, factsToConfirm: text.split('\n').filter(Boolean) }), 3, 40_000)
          : <ul>{value.factsToConfirm.map((text, i) => <li key={i}>{text}</li>)}</ul>}
      </details>}
    </div>
  );
}
