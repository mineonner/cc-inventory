---
description: เปิดหน้าเว็บ cc-inventory ดู Extension ทั้งหมดในเครื่อง (Plugin, Skill, Subagent, Hook, MCP) พร้อมคำอธิบาย ปิด/ลบ/ติดตั้ง และตรวจตัวที่ทำงานทับกัน
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/server/start.js"`

ข้อความด้านบนคือผลจากการเปิด cc-inventory ถ้ามีลิงก์ http://127.0.0.1 ให้ส่งลิงก์นั้นให้ผู้ใช้หนึ่งบรรทัดว่าเปิดในเบราว์เซอร์แล้ว ไม่ต้องทำอะไรเพิ่ม ถ้าเป็นข้อความ error ให้บอกผู้ใช้ตามนั้นและแนะนำวิธีแก้สั้นๆ
