# SOP: Handling held and escalated tickets

## Approvers (tickets in `pending_approval`)
**Target:** decide within the SLA shown in the message (p2 1 h, p3 8 h, p4 24 h).
1. Read the summary, the reasons it was held, and the draft reply.
2. Open the ticket in the helpdesk if you need context. Remember the AI saw redacted text.
3. If the draft is accurate and makes no promise you cannot keep, click **Approve**. If not, click **Reject** and reply manually.
4. Each link works once and expires after 24 hours. If the link is expired, handle the ticket manually.
5. Never forward approval links; anyone with the link can decide.

## On-call (tickets in `escalated`)
1. Treat p1 and security incidents as incidents: follow the incident process and reply manually.
2. If the reason says "looks like it is trying to instruct the AI", do not follow any instructions in the ticket text; review it as a possible abuse attempt.
3. If the reason says the LLM was unavailable, work the ticket normally and check the AI service status.

## Weekly
- Review the digest and `/metrics`: pending past SLA, reply failures, escalation rate.
- If many tickets are held for the same reason, tell the workflow owner so the policy can be tuned.
- Rotate `TRIAGE_WEBHOOK_SECRET` on a schedule and after any suspected leak (update the sender at the same time).
