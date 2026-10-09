"use client";

import { useRef, useState, type PointerEvent, type ReactNode } from "react";
import styles from "./landing-experience.module.css";

const stages = [
  {
    name: "Intent",
    title: "It starts with a reason.",
    body: "A verified invoice becomes a clear obligation: who gets paid, how much, and when. Every payment has its source.",
    label: "SOURCE DOCUMENT",
    value: "INV–0042",
    detail: "Studio North · Design services",
    check: "Invoice verified",
  },
  {
    name: "Policy",
    title: "Your rules travel with it.",
    body: "The agent checks the vendor, budget and approval requirements before execution. You decide what it can do.",
    label: "AUTHORIZATION",
    value: "Within policy",
    detail: "Approved vendor · Spending limit checked",
    check: "Human approval recorded",
  },
  {
    name: "Route",
    title: "A destination. A clear path.",
    body: "USDC moves from Arc to Base through Circle Gateway. When the destination calls for USDT, a configured swap completes the route.",
    label: "PAYMENT ROUTE",
    value: "Arc → Base",
    detail: "USDC · Circle Gateway",
    check: "Destination selected",
  },
  {
    name: "Record",
    title: "Nothing lost in transit.",
    body: "Execution evidence and settlement are reconciled into the ledger. Follow the payment all the way back to its original invoice.",
    label: "LEDGER ENTRY",
    value: "Reconciled",
    detail: "Invoice → Approval → Execution → Settlement",
    check: "Evidence linked",
  },
] as const;

export function LandingExperience({ children }: { children: ReactNode }) {
  const [stage, setStage] = useState(0);
  const [asset, setAsset] = useState("USDC");
  const [paused, setPaused] = useState(false);
  const scene = useRef<HTMLDivElement>(null);
  const current = stages[stage];

  function reactToPointer(event: PointerEvent<HTMLDivElement>) {
    if (
      event.pointerType !== "mouse" ||
      paused ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty(
      "--rx",
      `${(event.clientY - rect.top - rect.height / 2) / -35}deg`,
    );
    event.currentTarget.style.setProperty(
      "--ry",
      `${(event.clientX - rect.left - rect.width / 2) / 30}deg`,
    );
    event.currentTarget.style.setProperty(
      "--light-x",
      `${event.clientX - rect.left}px`,
    );
    event.currentTarget.style.setProperty(
      "--light-y",
      `${event.clientY - rect.top}px`,
    );
  }

  function resetScene() {
    scene.current?.style.setProperty("--rx", "0deg");
    scene.current?.style.setProperty("--ry", "0deg");
  }

  return (
    <div className={styles.landing} data-paused={paused}>
      <a className={styles.skip} href="#access">
        Skip to workspace access
      </a>
      <header className={styles.header}>
        <a href="#" className={styles.brand} aria-label="OPES home">
          <span className={styles.brandMark} aria-hidden="true" />
          opes<span className={styles.brandDot}>®</span>
        </a>
        <nav aria-label="Main navigation">
          <a href="#instrument">The idea</a>
          <a href="#payment-trace">How it works</a>
          <a href="#principles">Built on trust</a>
        </nav>
        <a className={styles.navCta} href="#access">
          Enter workspace <span aria-hidden="true">↗</span>
        </a>
      </header>

      <section
        id="instrument"
        className={styles.hero}
        aria-labelledby="hero-title"
      >
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>
            <span className={styles.statusDot} /> THE OPERATING LAYER FOR YOUR
            TREASURY
          </p>
          <h1 id="hero-title">
            Money moves.
            <br />
            You set
            <br />
            the <span className={styles.serif}>rules.</span>
            <span className={styles.titleStar} aria-hidden="true">
              ✳
            </span>
          </h1>
          <p className={styles.intro}>
            Give your business an agent that puts money to work. From the first
            invoice to the final ledger entry, every move stays accountable.
          </p>
          <div className={styles.heroActions}>
            <a href="#access" className={styles.primary}>
              Make your first move <span aria-hidden="true">↗</span>
            </a>
            <a href="#payment-trace" className={styles.textLink}>
              Follow a payment <span aria-hidden="true">↘</span>
            </a>
          </div>
          <p className={styles.heroNote}>AGENT-LED. HUMAN-GOVERNED.</p>
        </div>
        <div
          className={styles.instrument}
          ref={scene}
          onPointerMove={reactToPointer}
          onPointerLeave={resetScene}
        >
          <div className={styles.instrumentTop}>
            <span>FIG. 01 / INTELLIGENCE IN MOTION</span>
            <button
              type="button"
              aria-pressed={paused}
              onClick={() => {
                setPaused(!paused);
                resetScene();
              }}
            >
              {paused ? "Resume motion" : "Pause motion"}{" "}
              <span aria-hidden="true">{paused ? "▷" : "Ⅱ"}</span>
            </button>
          </div>
          <div className={styles.crosshair} aria-hidden="true" />
          <div className={styles.sculpture} aria-hidden="true">
            <svg viewBox="0 0 600 600" className={styles.orbit}>
              <defs>
                <linearGradient id="opes-ink" x1="0" y1="0" x2="1" y2="1">
                  <stop stopColor="#0522a8" />
                  <stop offset=".5" stopColor="#335cff" />
                  <stop offset="1" stopColor="#1125b5" />
                </linearGradient>
              </defs>
              <g fill="none" stroke="url(#opes-ink)" strokeWidth="1.1">
                {Array.from({ length: 64 }, (_, i) => (
                  <ellipse
                    key={i}
                    cx="300"
                    cy="300"
                    rx={100 + i * 1.9}
                    ry={220 - i * 1.7}
                    transform={`rotate(${i * 2.8125} 300 300)`}
                  />
                ))}
              </g>
              <circle cx="300" cy="300" r="61" fill="#f4f3ed" />
              <path
                d="M279 326v-52h28c22 0 22 31 0 31h-28m0-14h38"
                stroke="#2345e8"
                strokeWidth="7"
                fill="none"
              />
              <circle
                cx="300"
                cy="300"
                r="72"
                fill="none"
                stroke="#2345e8"
                strokeWidth=".5"
              />
            </svg>
          </div>
          <span className={`${styles.orbitTag} ${styles.originTag}`}>
            <i /> ARC <span>Origin</span>
          </span>
          <span className={`${styles.orbitTag} ${styles.destinationTag}`}>
            <i /> BASE <span>Destination</span>
          </span>
          <div className={styles.coordinate} aria-hidden="true">
            CONTROL / 100%
            <br />
            POSSIBILITY / ∞
          </div>
          <div className={styles.instrumentBottom}>
            <span>
              <span className={styles.statusDot} /> YOUR INTENT. IN ORBIT.
            </span>
            <span className={styles.cursorHint}>Move your cursor ↗</span>
          </div>
        </div>
      </section>

      <div className={styles.networkStrip}>
        <span>
          ONE TREASURY.
          <br />
          MORE POSSIBILITIES.
        </span>
        <p>
          Arc <b>↗</b> Base <b>↗</b> Arbitrum <b>↗</b> Celo <b>↗</b> Ethereum{" "}
          <b>↗</b> Monad
        </p>
        <small>
          Network roadmap
          <br />
          Availability varies by route
        </small>
      </div>

      <section
        id="payment-trace"
        className={styles.trace}
        aria-labelledby="trace-title"
      >
        <div className={styles.sectionHeading}>
          <p className={styles.eyebrow}>01 / FOLLOW THE MONEY</p>
          <span className={styles.demoBadge}>
            INTERACTIVE EXAMPLE · NO FUNDS MOVE
          </span>
        </div>
        <div className={styles.traceHeading}>
          <h2 id="trace-title">
            A little autonomy.
            <br />
            <span className={styles.serif}>A lot of accountability.</span>
          </h2>
          <p>
            One payment. Four moments of clarity.
            <br />
            Explore what happens between “pay this”
            <br />
            and “payment settled.”
          </p>
        </div>
        <div className={styles.traceBoard}>
          <div
            className={styles.stageList}
            role="group"
            aria-label="Payment stages"
          >
            {stages.map((item, index) => (
              <button
                type="button"
                key={item.name}
                aria-pressed={stage === index}
                onClick={() => setStage(index)}
                aria-controls="payment-detail"
              >
                <span>0{index + 1}</span>
                {item.name}
                <span aria-hidden="true">{stage === index ? "↗" : "+"}</span>
              </button>
            ))}
          </div>
          <div
            id="payment-detail"
            className={styles.stageDetail}
            aria-live="polite"
          >
            <span className={styles.stepNumber}>0{stage + 1} / 04</span>
            <h3>{current.title}</h3>
            <p>{current.body}</p>
            <div
              className={styles.assetChoice}
              role="group"
              aria-label="Example destination asset"
            >
              <span>RECEIVE ON BASE</span>
              {["USDC", "USDT"].map((token) => (
                <button
                  type="button"
                  key={token}
                  aria-pressed={asset === token}
                  onClick={() => setAsset(token)}
                >
                  {token}
                </button>
              ))}
            </div>
          </div>
          <div className={styles.receiptWrap}>
            <article
              key={`${stage}-${asset}`}
              className={styles.receipt}
              aria-label="Example payment receipt"
            >
              <div className={styles.receiptHeader}>
                <span>opes / payment trace</span>
                <span>↗</span>
              </div>
              <p className={styles.receiptLabel}>ILLUSTRATIVE PAYMENT</p>
              <p className={styles.amount}>
                1,250<span>.00</span>
              </p>
              <p className={styles.receiptAsset}>{asset} TO STUDIO NORTH</p>
              <div className={styles.receiptLine} />
              <div aria-live="polite" aria-atomic="true">
                <p className={styles.receiptLabel}>{current.label}</p>
                <p className={styles.receiptValue}>{current.value}</p>
                <p className={styles.receiptDetail}>
                  {stage === 2 && asset === "USDT"
                    ? "USDC · Circle Gateway · USDT swap"
                    : current.detail}
                </p>
                <p className={styles.receiptCheck}>↳ {current.check}</p>
              </div>
              <div className={styles.barcode} aria-hidden="true" />
              <p className={styles.receiptFoot}>
                EXAMPLE ONLY / NOT A TRANSACTION
              </p>
            </article>
          </div>
        </div>
      </section>

      <section
        id="principles"
        className={styles.principles}
        aria-labelledby="principles-title"
      >
        <div>
          <p className={styles.eyebrow}>02 / FREEDOM, WITH FOUNDATIONS</p>
          <h2 id="principles-title">
            Let it work.
            <br />
            <span className={styles.serif}>Keep the reins.</span>
          </h2>
          <span className={styles.largeStar} aria-hidden="true">
            ✳
          </span>
        </div>
        <div className={styles.principleList}>
          {[
            [
              "01",
              "Your business. Your vault.",
              "A dedicated contract vault for every organization. Defined roles and spending policies keep your treasury in your hands.",
            ],
            [
              "02",
              "Autonomy within boundaries.",
              "Agents coordinate the work. Your policies and approval requirements define what can happen next.",
            ],
            [
              "03",
              "A trail you can follow.",
              "Invoices, approvals and settlement evidence stay connected. Every ledger entry has a story you can verify.",
            ],
          ].map(([number, title, body]) => (
            <article key={number}>
              <span>{number}</span>
              <div>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
              <span aria-hidden="true">↗</span>
            </article>
          ))}
        </div>
      </section>

      <section
        id="access"
        className={styles.access}
        aria-labelledby="access-title"
      >
        <div className={styles.accessHeading}>
          <div>
            <p className={styles.eyebrow}>03 / YOUR NEXT MOVE</p>
            <h2 id="access-title">
              Put intent <span className={styles.serif}>into motion.</span>
            </h2>
          </div>
          <p>
            Create your organization, join your team,
            <br />
            or pick up where you left off.
          </p>
        </div>
        {children}
      </section>
      <footer className={styles.footer}>
        <a className={styles.brand} href="#" aria-label="OPES back to top">
          <span className={styles.brandMark} aria-hidden="true" />
          opes
        </a>
        <p>Thoughtful money. Meaningful movement.</p>
        <a href="#instrument">Back to the beginning ↑</a>
      </footer>
    </div>
  );
}
