// The part of an Explanation that is derived from files alone — always shown, never guessed.
export function howToUse(e) {
  const f = e.facts || {};
  switch (e.kind) {
    case 'skill': {
      const slash = `/${e.name}`;
      if (f.manualOnly) return { trigger: `พิมพ์ ${slash} เท่านั้น — Claude จะไม่เลือกใช้เอง`, slash };
      if (f.autoOnly) return { trigger: 'Claude เลือกใช้เองเมื่อคำขอตรงกับ description — พิมพ์เรียกเองไม่ได้', slash: null };
      return { trigger: `พิมพ์ ${slash} หรือพูดถึงงานที่ตรงกับ description แล้ว Claude จะเลือกใช้เอง`, slash };
    }
    case 'command':
      return { trigger: `พิมพ์ /${e.name}${f.argumentHint ? ` ${f.argumentHint}` : ''}`, slash: `/${e.name}` };
    case 'agent':
      return { trigger: `Claude ส่งงานให้ผ่าน Agent tool เมื่องานตรงกับ description หรือสั่งตรงๆ เช่น "ใช้ ${e.name} agent ตรวจ..."`, slash: null };
    case 'hook':
      return { trigger: `ทำงานเองตอน event ${f.event}${f.matcher ? ` กับ tool ที่ตรง "${f.matcher}"` : ''} — ไม่ต้องเรียก`, slash: null };
    case 'mcp':
      return { trigger: `เพิ่ม tool ชื่อ mcp__${e.name}__* ให้ Claude เรียกใช้เมื่องานต้องการ (ดูรายการด้วย /mcp)`, slash: null };
    case 'plugin': {
      const c = f.components || {};
      const parts = Object.entries(c).map(([k, n]) => `${n} ${KIND_TH[k] || k}`);
      return { trigger: parts.length ? `บรรจุ ${parts.join(', ')} — ใช้งานผ่านส่วนประกอบเหล่านั้น` : 'ใช้งานผ่านส่วนประกอบข้างใน', slash: null };
    }
    case 'statusline':
      return { trigger: 'แสดงผลเองที่แถบล่างของ Claude Code CLI', slash: null };
    case 'outputstyle':
      return { trigger: `เลือกด้วย /output-style ${e.name} หรือตั้ง "outputStyle" ใน settings.json`, slash: null };
    default:
      return { trigger: '', slash: null };
  }
}

export const KIND_TH = {
  skill: 'Skill', agent: 'Subagent', command: 'Command', hook: 'Hook', mcp: 'MCP', plugin: 'Plugin', statusline: 'Status line', outputstyle: 'Output style',
};
