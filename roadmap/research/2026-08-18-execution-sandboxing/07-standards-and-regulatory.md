# 07 — Standards and Regulatory Landscape

**Research date:** 2026-08-18. Consolidates four sub-lane reports (OWASP/NIST/NCSC, ISO/IEC,
CISA/ENISA/EU, and a standards-guidance sweep).
**Status:** research input only — see [`README.md`](README.md).

> **Bottom line for engineering: nothing here changes the architecture.** These documents tell you to
> *have a risk process*, not which sandbox to build. The load-bearing citations are NCSC's December 2025
> post and OWASP LLM01:2026, both of which say the same thing our own evidence says — defense must be
> architectural, not interceptive.

---

## 1. OWASP

### LLM Top 10 2026 — exists, and is more agent-aware

**"OWASP Top 10 for LLM Applications 2026"**, resources-library date **2026-08-03**, 122-page PDF.

> **Caveat:** the shipped PDF's cover page reads *"[Publication date to be set]"* and its revision
> history *"[2026 release date] Version 2026 Release"* — unfilled placeholders. The August 3 date comes
> from library metadata, not the document. Treat as early August 2026.

**Ordering change:** LLM01 Prompt Injection held #1. **LLM03 Excessive Agency climbed from #6.**
LLM08 renamed/re-scoped from System Prompt Leakage to Hidden Context Exposure. LLM10 Improper Output
Handling fell from #5.

Methodology note, verbatim: *"The order moved more than in past years… Excessive Agency climbed to third,
the most consequential move on the list, because the vote and the record agree that agentic deployments
are where the damage is landing."*

**The LLM/agentic boundary, verbatim:** *"This list owns the risk when the model is a component inside
your application. The moment that model becomes an actor, with tools it can call, memory it carries
between sessions, and consequences it sets in motion downstream, the risk moves to the OWASP Agentic
Top 10."*

**LLM01:2026 definition, verbatim:**

> *"A prompt-injection vulnerability occurs when input to a large language model (LLM), whether direct
> user input, retrieved content, tool output, image, audio, or video content, intermediate reasoning, or
> persistent memory, alters the model's behavior in ways the application developer did not intend. LLMs
> make no architectural distinction between 'instructions' and 'data' (both are tokens on the same
> stream), so there is no clean equivalent to parameterized queries (NCSC, 2025)."*

Names three aggravating deployment properties — **"context-window pooling"**, **"memory persistence"**,
**"agentic execution"** — and a three-axis anatomy: **delivery surface / propagation behavior /
encoding**. Introduces a trust gradation — **"Untrusted / Semi-trusted / Trusted surfaces"** — with:

> *"The shared structure: the attacker does not need to compromise the backend directly. They place text
> where the developer's LLM will read it, and the LLM, operating with the developer's privileges, does
> the work. Defenses that focus only on the chat surface miss this entirely."*

**The mitigation framing is materially stronger than 2025:**

> *"Prompt injection is intrinsic to current generative AI… so **no reliable prevention mechanism exists
> today**, a position consistent with NIST (2025), NCSC (2025), and Debenedetti et al. (2025). **Defense
> is therefore architectural rather than interceptive.** Design the surrounding system on the explicit
> assumption that the model's instruction boundary will eventually be bypassed…"*

Eleven mitigations (2025 had seven). Notable additions:
- **#5** Strip tag-block (U+E0000–E007F), variation-selector (U+FE00–FE0F), and zero-width
  (U+200B/200C/200D/2060) characters at every ingest and render boundary.
- **#8** *"Budget agent capabilities with the **Rule of Two** as a floor (Meta AI, 2025). Treat
  simultaneous access to (A) untrusted input, (B) sensitive data, and (C) state change or external
  communication as high-risk."*
- **#9** *"Treat agent memory writes as privileged operations."*
- **#10** *"Pin, sign, and verify every MCP server and third-party tool package, audit tool descriptions
  for hidden instructions."*
- **#11** *"Test against adaptive attackers who have read the deployed defense, and **reject static-only
  attack-success claims.** … **Nasr et al. (2025) found static attack success near zero while adaptive
  attack success exceeded 90% for most of 12 recent defenses.**"*

Each mitigation carries an explicit stated limitation — e.g. #1 *"This is a partial control only"*; #6
*"StruQ was bypassed under adaptive attack."* OWASP formally adopts Willison's framing: *"Simon
Willison's 'lethal trifecta' (2025) restates the same structural diagnosis as a pre-deployment check."*

### LLM01:2025 (the prior list, released 2024-11-18)

> *"A Prompt Injection Vulnerability occurs when user prompts alter the LLM's behavior or output in
> unintended ways. These inputs can affect the model even if they are imperceptible to humans…"*

Framing sentence: *"Given the stochastic influence at the heart of the way models work, it is unclear if
there are fool-proof methods of prevention for prompt injection."* Seven mitigations: constrain model
behavior; define and validate expected output formats; input/output filtering; **enforce privilege
control and least privilege access** (*"Provide the application with its own API tokens for extensible
functionality, and handle these functions in code rather than providing them to the model"*); require
human approval for high-risk actions; segregate and identify external content; adversarial testing.

Mapped to MITRE ATLAS **AML.T0051.000** (direct), **AML.T0051.001** (indirect), **AML.T0054**.

### Agentic Security Initiative

**"Agentic AI – Threats and Mitigations"** — original **2025-02-17**; current PDF **"Version 1.1
December 2025"**, 53 pages, CC BY-SA 4.0. **The taxonomy runs T1–T17, not T1–T15:**

| Code | Name |
|---|---|
| T1 | Memory Poisoning |
| T2 | Tool Misuse |
| T3 | Privilege Compromise |
| T4 | Resource Overload |
| T5 | Cascading Hallucination Attacks |
| T6 | Intent Breaking & Goal Manipulation |
| T7 | Misaligned & Deceptive Behaviors |
| T8 | Repudiation & Untraceability |
| T9 | Identity Spoofing & Impersonation |
| T10 | Overwhelming Human-in-the-Loop |
| T11 | Unexpected RCE and Code Attacks |
| T12 | Agent Communication Poisoning |
| T13 | Rogue Agents in Multi-Agent Systems |
| T14 | Human Attacks on Multi-Agent Systems |
| T15 | Human Manipulation |
| **T16** | **Insecure Inter-Agent Protocol Abuse** |
| **T17** | **Supply Chain Compromise** |

T16/T17 are the v1.1 additions. *(T14's code+name pairing is inferred from the playbook mapping table.)*

**T6 is the prompt-injection tie-in:** *"Intent Breaking and Goal Manipulation occurs when attackers
exploit the lack of separation between data and instructions in AI agents… attackers can inject
adversarial objectives that shift an agent's long-term reasoning processes."*

### OWASP Top 10 for Agentic Applications 2026 — **released, not draft**

Announced **2025-12-09** at the London Agentic Security Summit. Chair: John Sotiropoulos. >100
contributors. Expert Review Board included **NIST's Apostol Vassilev**, the Alan Turing Institute, and
the European Commission.

| Code | Name | Cited exemplar |
|---|---|---|
| ASI01 | Agent Goal Hijack | EchoLeak |
| ASI02 | Tool Misuse & Exploitation | Amazon Q |
| ASI03 | Identity & Privilege Abuse | — |
| ASI04 | Agentic Supply Chain Vulnerabilities | GitHub MCP exploit |
| ASI05 | Unexpected Code Execution (RCE) | AutoGPT RCE |
| ASI06 | Memory & Context Poisoning | Gemini Memory Attack |
| ASI07 | Insecure Inter-Agent Communication | — |
| ASI08 | Cascading Failures | — |
| ASI09 | Human-Agent Trust Exploitation | — |
| ASI10 | Rogue Agents | Replit meltdown |

**Appendix A maps LLM01 → ASI01, ASI02, ASI03, ASI05, ASI06, ASI08, ASI09** — the widest fan-out of any
LLM risk.

**Other ASI output:** "Securing Agentic Applications Guide 1.0" (2025-07-27); "CheatSheet – A Practical
Guide for Securely Using Third-Party MCP Servers 1.0" (2025-11-04); **"A Practical Guide for Secure MCP
Server Development" (2026-02-16)** — *"Unlike traditional APIs, MCP servers operate with delegated user
permissions, dynamic tool-based architectures, and chained tool calls, increasing the potential impact
of a single vulnerability."*

---

## 2. NIST

### AI 100-2e2025 — the taxonomy

**"Adversarial Machine Learning: A Taxonomy and Terminology of Attacks and Mitigations", NIST AI 100-2
E2025, March 2025** (CSRC "Released 03/24/2025"). DOI 10.6028/NIST.AI.100-2e2025. Authors: Vassilev
(NIST), Oprea (Northeastern), Fordyce & Anderson (Cisco), Davies (UK AI Security Institute), Hamin (US
AI Safety Institute). Supersedes AI 100-2e2023. **No 2026 revision or draft exists** — only an errata
note (2025-06-03) about an error on page x.

**Direct prompt injection (§3.3, NISTAML.018):** *"DIRECT PROMPTING ATTACK attacks arise when the attacker
is the primary user of the system… A subset of these attacks, in which the main user provides in-context
instructions that are appended to higher-trust instructions like those provided by the application
designer (such as the model's SYSTEM PROMPT), are known as DIRECT PROMPT INJECTION attacks."*

**Indirect (§3.4, NISTAML.015):** *"Because GenAI models combine the data and instruction channels,
attackers can leverage the data channel to affect system operations by manipulating resources with which
the system interacts. Thus, INDIRECT PROMPT INJECTION attacks are enabled by RESOURCE CONTROL…"*

**Mitigations (§3.4.4)** — training techniques, detection schemes, input processing (filtering,
**spotlighting**). Critically:

> *"Because current mitigations do not offer full protection against all attacker techniques, application
> designers may design systems with the assumption that prompt injection attacks are possible if a model
> is exposed to untrusted input sources, such as by using multiple LLMs with different permissions or by
> allowing models to interact with potentially untrustworthy data sources only through well-defined
> interfaces."*

That is NIST endorsing, in substance, the dual-LLM and design-pattern approaches.

**§3.5 "Security of Agents":** *"Because agents rely on GenAI systems to plan and execute their actions,
they can be vulnerable to many of the above categories of attacks… However, because agents can take
actions using tools, these attacks can create additional risks in this context, such as **enabling actors
to hijack agents to execute arbitrary code or exfiltrate data** from the environment in which they are
operating. Security research focused specifically on agents is still in its early stages…"*

§3.6 names **AgentDojo** and **AgentHarm** as benchmarks.

### AI 600-1 — GenAI Profile

**NIST AI 600-1, July 2024** (published 2024-07-26). §2.9 Information Security: *"…it expands the
available attack surface, as GAI itself is vulnerable to attacks like prompt injection or data
poisoning."* / *"Security researchers have already demonstrated how indirect prompt injections can
exploit vulnerabilities by stealing proprietary data or running malicious code remotely on a machine."*
**No 2026 update.**

### COSAiS — status as of August 2026

- Project page `csrc.nist.gov/projects/cosais` created 2025-07-10; **concept paper released 2025-08-14**,
  proposing five use cases including **"Using AI Agent Systems – Single Agent"** and **"– Multi-Agent"**.
- **Draft Annotated Outline, 2026-01-08** (for Cyber AI Profile Workshop #2), setting out numbering:
  > *"1. NISTIR 8605, Control Overlays for Securing AI Systems: Overview and Methodology / 2. NISTIR
  > 8605A… Using and Fine-Tuning Predictive AI / 3. NISTIR 8605B… Adapting and Using Generative AI /
  > 4. NISTIR 8605C… Security Controls for AI Developers / 5. NISTIR 8605D… Using Agentic AI: Single
  > Agent and Multi-Agent"*
  > *"NIST intends to issue NISTIR 8605 and NISTIR 8605A as drafts for public comment by Q3 FY2026… The
  > series (all volumes) will be finalized in 2027."*
- **Verified: NO NISTIR 8605-series document has been released.** `csrc.nist.gov/pubs/ir/8605/ipd` and
  `/pubs/ir/8605/a/ipd` both return **404**. **The agentic overlay (8605D) is last in the release order
  and is a 2027 item.**

### Other NIST

- **SP 800-218A**, "Secure Software Development Practices for Generative AI and Dual-Use Foundation
  Models: An SSDF Community Profile", **July 2024, Final**. Co-authored with CISA's Martin Stanley.
- **NIST IR 8596**, "Cybersecurity Framework Profile for Artificial Intelligence (Cyber AI Profile)" —
  **Preliminary Draft 2025-12-16**, comments closed 2026-01-30. Three focus areas: **Secure / Defend /
  Thwart**. `/pubs/ir/8596/final` returns 404 — **not finalized**.
- **AI Agent Standards Initiative** — launched by NIST's Center for AI Standards and Innovation (CAISI),
  **2026-02-17**. Three pillars: industry-led agent standards, community-led open-source protocol
  development, research in AI agent security and identity.
- **Federal Register RFI** "Security Considerations for Artificial Intelligence Agents", **2026-01-08**;
  comments closed **2026-03-09**. Summary analysis published ~April 2026.
- **NCCoE Concept Paper** "Accelerating the Adoption of Software and Artificial Intelligence Agent
  Identity and Authorization", **2026-02-05**.
- **Draft SP 800-239**, "AI Data Center Security Analysis" — initial public draft **2026-07-27**,
  comments due 2026-09-25.

---

## 3. UK NCSC

### The 2025 position — the single most quotable government statement

**"Prompt injection is not SQL injection (it may be worse)"**, NCSC blog, **2025-12-08**, by Dave
Chismon, NCSC CTO for Architecture.

> *"Under the hood of an LLM, there's no distinction made between 'data' or 'instructions'; there is only
> ever 'next token.'"*
> *"prompt injection attacks will remain a residual risk, and cannot be fully mitigated with a product or
> appliance etc."*
> *"when an LLM processes information from a party, the privileges it has drops to that of the party."*

Recommends **deterministic (non-LLM) safeguards that constrain the actions of the system**; endorses XML
tagging / visual separation as risk-reducing but not eliminating; dismisses *"denylisting known bad
content"*; recommends logging *"full input and output of the LLM, as well as tool use, API calls."*
Rejects vendor claims to "stop" prompt injection in favour of demonstrated risk *reduction*.

Companion news item (2025-12-10): prompt injection *"may never be totally mitigated in the way SQL
injection attacks can be."*

**This is the "(NCSC, 2025)" that OWASP's LLM01:2026 cites in its opening sentence.**

### Earlier and related

- **"Thinking about the security of AI systems"** (2023-08-30) — *"'prompt injection', which is when a
  user creates an input designed to make the model behave in an unintended way."* Recommends *"applying a
  rules-based system on top of the ML model to prevent it from taking damaging actions, even when
  prompted."*
- **"Exercise caution when building off LLMs"** (2023-08-30) — *"Research is suggesting that an LLM
  inherently cannot distinguish between an instruction and data provided to help complete the
  instruction."*
- **"Guidelines for secure AI system development"** (**2023-11-27**, joint NCSC/CISA, co-sealed by
  agencies from 23 countries incl. all G7). Four lifecycle sections: **Secure design, Secure development,
  Secure deployment, Secure operation and maintenance.**
- **DSIT "AI Cyber Security Code of Practice"** (**2025-01-31**), developed with NCSC; 13 principles.
  Subsequently published by ETSI as **ETSI TS 104 223** (implementation guide TR 104 128), endorsed by
  18 countries. *(A DSIT publication, not an NCSC one.)*
- **"Impact of AI on cyber threat from now to 2027"** (2025-05-07, launched at CYBERUK 2025). Its body
  text does **not** substantively discuss AI agents — it predates NCSC's dedicated agentic guidance by a
  year.
- **"Cyber Shield: The path to an agentic AI future for cyber defence"** (2026-07-07) — a national
  defensive capability initiative, not general guidance.

### 2026 agentic guidance — Five Eyes

**"Thinking carefully before adopting agentic AI"**, NCSC blog, **May 2026** (15 or 18 May — sources
conflict), aligned with a **Five Eyes** joint product (ASD ACSC, CISA, NSA, CCCS, NCSC-NZ, NCSC-UK). NZ's
companion "Careful Adoption of Agentic AI Services" is dated **2026-05-01**; CISA's is **2026-05-01**.

Verbatim definition: *"Agentic AI represents the next step for the most advanced generative AI… Rather
than outputting a prediction or new content, agentic systems can access data sources, remember context,
make decisions, use tools, and take actions in pursuit of a goal. They can operate without continuous
human intervention and even create sub-agents to complete specific tasks."*

On risk: *"Agentic AI systems also inherit known LLM risks like susceptibility to jailbreaking and prompt
injection… However, the extra autonomy and complexity of agentic systems can increase the attack surface
and make behaviour harder to predict, test and govern."*

Recommendations, verbatim:
> *"deploy agentic AI incrementally, starting with tightly bounded pilots using clearly defined tasks"*
> *"give agents only the minimum access they need, for the shortest time required"*
> *"constrain what an agent can access, what actions it can take and when it can take them"*
> *"use temporary credentials where possible and revoke elevated access when tasks are complete"*
> *"**If you cannot understand, monitor or contain an agent's actions, it is not ready for deployment.**"*

---

## 4. CISA / ENISA / EU

### CISA
- **"AI Data Security: Best Practices for Securing Data Used to Train & Operate AI Systems"**,
  **2025-05-22.** Co-sealers: NSA (AISC, lead), CISA, FBI, ASD's ACSC, NCSC-NZ, NCSC-UK. *(Canada and
  Germany are **not** co-sealers of this one — do not conflate with the Dec 2025 OT guidance.)*
- **"Careful Adoption of Agentic Artificial Intelligence (AI) Services"**, **released 2026-05-01.** Named
  risks: *"an expanded attack surface, privilege creep, behavioral misalignment, and obscure event
  records."*
- **"Principles for the Secure Integration of AI in Operational Technology"**, **2025-12-03** (not 2026,
  despite some secondary sources). Co-developed with ASD's ACSC, NSA AISC, FBI, Canadian Centre for Cyber
  Security, German BSI, NCSC-NL, NCSC-NZ, NCSC-UK. Four principles: Understand AI, Assess AI Use in OT,
  Establish AI Governance, Embed Safety and Security.

### ENISA
- **"ENISA's view on Cybersecurity in the Frontier AI Era"**, **2026-07-07** (TLP:CLEAR, 16 pages) — the
  most current ENISA AI-security document. Published alongside the European Commission's Action Plan on
  Cybersecurity and AI (same date), applying NIS2, the CRA, the AI Act, and DORA to advanced-AI risks.
  Recommends EU-level security benchmarks and standardized cyber-range testing; national-level AI-powered
  threat hunting, "AI incident" playbooks, baseline zero-trust for critical operators. A new EU evaluation
  capability for advanced AI models is planned operational in **2027**.
- **ENISA Threat Landscape 2025**, published **2025-10-01**, v1.2 revision 2026-01-09; 4,875 incidents
  analysed (1 Jul 2024 – 30 Jun 2025). **Contains zero literal matches for "prompt injection" or
  "agentic"** across 89 pages — searched directly. It covers adjacent ground: the **"Rules File Backdoor"**
  supply-chain vector *"enabling the injection of malicious instructions into configuration files that AI
  coding assistants use, like Cursor and GitHub Copilot"*; the **EchoLeak** Copilot vulnerability;
  "slopsquatting"; and jailbroken LLMs (WormGPT, EscapeGPT, FraudGPT).
- **"Multilayer Framework for Good Cybersecurity Practices for AI"**, **2023-06-07** — three layers
  (cybersecurity foundations / AI-specific / sector-specific). Not a 2025/2026 document.
- **"Cybersecurity of AI and Standardisation"**, 2023-03-14.

### EU AI Act — Article 15

**Regulation (EU) 2024/1689, Article 15(5), verbatim:**

> *"High-risk AI systems shall be resilient against attempts by unauthorised third parties to alter their
> use, outputs or performance by exploiting system vulnerabilities… The technical solutions to address AI
> specific vulnerabilities shall include, where appropriate, measures to prevent, detect, respond to,
> resolve and control for attacks trying to manipulate the training data set (data poisoning), or
> pre-trained components used in training (model poisoning), inputs designed to cause the AI model to
> make a mistake (adversarial examples or model evasion), confidentiality attacks or model flaws."*

**Note the gap: Article 15 never says "prompt injection."** The closest hooks are "adversarial examples
or model evasion" and "model flaws." Academic commentary (arXiv:2603.23471) flags this for agentic AI:
*"its list of vulnerabilities is not well-suited to AI agents… rather than broader agentic misuse
scenarios."*

High-risk obligations became enforceable **2026-08-02** *(per secondary compliance guidance; eur-lex
returns 403 to automated fetchers — not primary-verified)*. **Vorno is a desktop tool, not an Annex III
high-risk system.**

### CEN-CENELEC JTC 21

- The cybersecurity deliverable is **prEN 18282 — "Cybersecurity specifications for AI systems"**
  (CEN/CLC/JTC21 WG5), operationalizing Article 15(5) and aligning with the Cyber Resilience Act.
- **2026-05-08:** JTC21 announced both EN 18228 (AI Risk Management) and prEN 18282 became *"available
  for Public Enquiry."*
- **Current stage:** Public Enquiry, hearing period to **2026-07-30** *(per secondary trackers; not
  confirmed on cencenelec.eu)*. **Not published, not voted, not cited in the Official Journal** — it does
  **not yet** confer Article 40 presumption of conformity.
- **Acceleration:** on **2025-10-23** CEN/CENELEC adopted an "exceptional package of measures" — allowing
  direct publication after a positive Enquiry vote without a separate Formal Vote, plus a small drafting
  group for the most delayed drafts. Prioritized deliverables targeted for **Q4 2026**.
- **As of August 2026, zero JTC21 AI Act deliverables have been published or cited in the OJ.** The most
  advanced overall is EN 18286 (Quality Management Systems), at "Approval."

---

## 5. ISO/IEC

- **ISO/IEC 42001:2023** — "Information technology — Artificial intelligence — Management system",
  **published 2023-12-18** (some sources say 2023-12-31), ISO/IEC JTC 1/SC 42. The first AI
  management-system standard, structured like ISO/IEC 27001 (Annex SL, Clauses 4–10). Annex A has 38
  controls across 9 categories. A 2026 European adoption BS EN ISO/IEC 42001:2026 exists with "no
  technical differences."
  **It does not appear to name "prompt injection" anywhere** — consistent with a technology-agnostic
  management-system standard (27001 never names SQL injection). Every "42001 + prompt injection" link
  found is third-party commentary mapping the risk *under* the framework.
- **ISO/IEC 27090** — "Cybersecurity — Artificial Intelligence — Addressing security threats and
  compromises to artificial intelligence systems." **NOT yet published — at FDIS.** Stage **50.20, dated
  2026-06-23** (8-week ballot). 56 pages. Supersedes ISO/IEC DIS 27090:2025-04. Covers a dozen-plus
  AI-specific threat scenarios including data and model poisoning; **explicitly excludes "AI vs AI"
  scenarios.** References 42001, 38507, 22989, 5338.
  **This is the one to track** — it is the first ISO standard aimed squarely at AI-specific security
  threats across the lifecycle, and the document most likely to appear on enterprise security
  questionnaires.
- **ISO/IEC 27091** — "Cybersecurity and Privacy — Artificial Intelligence — Privacy protection."
  Under development, stage **50.00** (FDIS registered), one step behind 27090. Companion document.
- **ISO/IEC 23894:2023** — "Guidance on risk management", published **February 2023**. Guidance, not
  requirements — no certification possible. Designed alongside ISO 31000:2018.
- **ISO/IEC TR 24028:2020** — "Overview of trustworthiness in artificial intelligence" (May 2020).
- **ISO/IEC 5338:2023** — "AI system life cycle processes."
- **ISO/IEC 42005:2025** — "AI system impact assessment", most-cited date 2025-04-17.

> **Methodology caveat:** every direct iso.org and `cms/render/live` URL returned **HTTP 403** behind a
> Cloudflare challenge, via both WebFetch and curl with a browser UA. All ISO facts above come from
> Google-cached snippets of the actual iso.org pages, cross-checked against DIN Media, ANSI/INCITS, AI
> Standards Hub, and ISO27001security.com. **Stage codes are well-corroborated but not primary-verified.**
> One sub-lane could not verify 27090's stage at all and recommended asserting none — the FDIS 50.20
> figure comes from the lane that reached a cached iso.org project page.

---

## 6. What this means for Vorno

1. **No compliance obligation applies today.** Vorno is not an Annex III high-risk AI system; no
   harmonised standard confers presumption of conformity; NIST's agentic overlays are a 2027 item.
2. **The externally citable support for an architectural approach is strong and recent.** NCSC's
   "deterministic (non-LLM) safeguards that constrain the actions of the system", OWASP LLM01:2026's
   "defense is architectural rather than interceptive", and NIST AI 100-2e2025 §3.5 all point the same
   way as the engineering evidence.
3. **Two documents to watch:** **ISO/IEC 27090** (FDIS, publishing later in 2026) and **prEN 18282**
   (Public Enquiry closed, targeted Q4 2026). Neither requires action now; both will show up in
   enterprise procurement eventually.
4. **The regulatory corpus is roughly a year behind engineering reality.** ENISA's 2025 Threat Landscape
   doesn't use the phrase "prompt injection"; the EU AI Act doesn't name it; ISO 42001 doesn't mention
   it. Only NCSC (Dec 2025), OWASP (2026), and NIST AI 100-2e2025 speak directly to the problem.

---

## Could not verify

- The OWASP LLM Top 10 2026's own publication date (PDF contains literal placeholders).
- T14's code-to-name binding in the ASI taxonomy.
- ISO/IEC 27090 / 27091 stage codes from a primary source (iso.org is fully bot-blocked).
- ISO/IEC 42001's silence on prompt injection — inferred from scope, not a verbatim ISO statement.
- Exact date of the NCSC agentic AI blog (15 vs 18 May 2026).
- Partner counts for the Nov 2023 Guidelines ("23 co-sealers" vs "19 international partners").
- Full body text of the CISA May 2025 AI Data Security guidance (media.defense.gov returned Access Denied).
- Prompt-injection content inside the ENISA Multilayer Framework PDF.
- **NIST AI 800-1** — referenced only as "Draft" on the COSAiS page; title, date, content unverified.
- The exact prEN 18282 enquiry closing date (secondary trackers only).
- EU AI Act high-risk enforceability date of 2026-08-02 (secondary compliance sources; eur-lex 403s).
