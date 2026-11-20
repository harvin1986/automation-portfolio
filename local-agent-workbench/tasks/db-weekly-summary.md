---
name: db-weekly-summary
tools: db.query, note.save
schedule: 0 8 * * 1
---
Using read-only SQL, summarize last week's activity in my database: row counts for the
main tables and anything unusual. Save the summary as a note.
