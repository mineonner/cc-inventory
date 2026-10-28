# cc-inventory

Claude Code plugin ที่เปิดหน้าเว็บในเครื่อง เพื่อดู Extension ทั้งหมดที่ติดตั้งอยู่ — Plugin, Skill, Subagent, Command, Hook, MCP server, Status line, Output style — พร้อมคำอธิบายภาษาไทยว่าแต่ละตัวคืออะไร ใช้ยังไง ทำงานยังไง ปิด/ลบ/ติดตั้งได้ และบอกตัวที่ทำงานทับกัน (Overlap) จน Claude อาจเลือกใช้สลับไปมา

## ติดตั้ง

ต้องมี [Node.js](https://nodejs.org) 20 ขึ้นไป และ Claude Code

```bash
claude plugin marketplace add mineonner/cc-inventory
claude plugin install cc-inventory@cc-inventory
```

หรือใน Claude Code พิมพ์ `/plugin marketplace add mineonner/cc-inventory` แล้ว `/plugin install cc-inventory@cc-inventory`

## ใช้งาน

พิมพ์ `/cc-inventory:inventory` ใน Claude Code (ในโฟลเดอร์โปรเจกต์ไหนก็ได้) — เบราว์เซอร์จะเปิดหน้า cc-inventory ให้เอง

ชื่อสั้น `/inventory` อาจใช้ได้ถ้าไม่มี command อื่นชื่อซ้ำ แต่ทดสอบแล้วว่าใน `claude -p` ชื่อสั้นไม่ทำงาน — ใช้ชื่อเต็มจะแน่นอนกว่า

- ปิดแท็บแล้ว server จะหยุดเองภายใน ~1 นาที
- เรียกซ้ำจะใช้ server เดิม
- ไม่มี Claude Code ก็รันตรงได้: `node server/start.js`

## ทำอะไรได้บ้าง

| | |
|---|---|
| **ดูรวม** | ทุกหมวด แยก scope (user / project / local / plugin / claude.ai / built-in) และสถานะ Active / Disabled / Ignored |
| **Ignored** | จับ config ที่ Claude Code ไม่อ่าน เช่น MCP ใน `~/.claude/mcp.json` หรือ `mcpServers` ใน `settings.json` |
| **คำอธิบาย** | 6 หัวข้อ: คืออะไร / ทำหน้าที่อะไร / ใช้ยังไง / ทำงานยังไง / ทับกับ / ข้อควรระวัง — ส่วน "จากไฟล์" ถูกต้องแน่นอน ส่วน "สรุปโดย Claude" สร้างด้วย `claude -p --safe-mode` (Haiku) ครั้งแรกครั้งเดียว แล้ว cache ตามเนื้อหาไฟล์ |
| **Overlap** | ชื่อซ้ำ + ความคล้ายของชื่อและ description (TF-IDF, ตัดคำไทยด้วย `Intl.Segmenter`) พร้อมสถิติการใช้จริงจาก `~/.claude.json` และปุ่มให้ Claude ตัดสินว่าควรเก็บตัวไหน |
| **ปิด / เปิด** | คืนค่าได้เสมอ (ดูตารางด้านล่าง) |
| **ลบ** | ต้องยืนยัน และสำรองไฟล์ไว้ที่ `~/.claude/cc-inventory/backups/` ก่อนทุกครั้ง |
| **ติดตั้ง** | Plugin จาก marketplace, MCP จากฟอร์ม (แสดงคำสั่งก่อนรัน ซ่อน secret), Skill จาก git URL หรือโฟลเดอร์ — ตรวจชื่อซ้ำและ Overlap ก่อนติดตั้ง |

### ปิดแต่ละหมวดยังไง

| หมวด | วิธีปิด |
|---|---|
| Plugin | `claude plugin disable` |
| Skill / Subagent / Command / Output style | ย้ายไปโฟลเดอร์ `*-disabled` ข้างๆ (เช่น `skills-disabled/`) |
| Hook / Status line | ย้าย entry ออกจาก `settings.json` ไปเก็บใน `~/.claude/cc-inventory/disabled.json` |
| MCP (project) | เพิ่มชื่อใน `disabledMcpjsonServers` ของ `.claude/settings.local.json` |
| MCP (user/local) | เก็บ config ไว้ แล้ว `claude mcp remove` — เปิดคืนด้วย `claude mcp add-json` (server ที่ login ด้วย OAuth อาจต้อง login ใหม่) |

Extension ที่อยู่ใน Plugin, sync มาจาก claude.ai หรือมากับ Claude Code แก้ไขรายตัวไม่ได้ — หน้าเว็บจะบอกเหตุผลและทางที่ทำได้

## ความปลอดภัย

- server ฟังเฉพาะ `127.0.0.1` port สุ่ม ทุก request ต้องมี token ที่ได้จากคำสั่งเปิด และปฏิเสธ Host/Origin อื่น (กัน CSRF / DNS rebinding)
- เรียก `claude`/`git` โดยไม่ผ่าน shell — ค่าที่ผู้ใช้กรอกไม่ถูกตีความเป็นคำสั่ง
- ค่า env ของ MCP ไม่ถูกส่งออกจาก server
- ไม่เขียน `~/.claude.json` ตรงๆ (Claude Code เขียนไฟล์นี้ตลอด) — ใช้ `claude mcp` แทน; `settings.json` เขียนแบบ atomic

## ข้อจำกัดที่รู้อยู่

- รายการ built-in skill/agent ของ Claude Code เป็นรายการตายตัวใน `server/builtins.json` (ตรวจล่าสุดกับ v2.1.308) อาจไม่ครบเมื่อ Claude Code อัปเดต
- Windows ที่ติดตั้ง Claude Code ผ่าน npm (`claude.cmd`) ส่งค่าที่มีอักขระพิเศษ (`" % ^ & | < > !`) ไม่ได้ เช่นการเปิด MCP ที่ปิดไว้กลับ — แนะนำ native installer (`claude.exe`)
- Skill จาก claude.ai อ่านจากโฟลเดอร์ sync ล่าสุดของ desktop app

## พัฒนา

```bash
node --test test/
node server/start.js
```

ไม่มี dependency ภายนอก CI ทดสอบบน Ubuntu / macOS / Windows × Node 20, 22 คำศัพท์ที่ใช้ดูใน [GLOSSARY.md](GLOSSARY.md)
