import { motion, type Variants } from "motion/react";
import { ArrowRight, BookOpen, Sparkles } from "lucide-react";
import { site } from "@/site";
import { Workspace } from "./Workspace";

const container: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08, delayChildren: 0.1 } },
};
const item: Variants = {
  hidden: { y: 18, opacity: 0 },
  show: { y: 0, opacity: 1, transition: { duration: 0.6, ease: "easeOut" } },
};

export function Hero() {
  return (
    <section id="top" className="relative mx-auto max-w-7xl px-6 pt-32 pb-20 md:pt-40">
      <div className="grid items-center gap-12 lg:grid-cols-[0.9fr_1.1fr]">
        <motion.div variants={container} initial="hidden" animate="show" className="min-w-0">
          <motion.a
            variants={item}
            href={site.githubUrl}
            target="_blank"
            rel="noreferrer"
            className="glass inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs text-muted transition-colors hover:text-fg"
          >
            <Sparkles className="h-3.5 w-3.5 text-brand-2" />
            Open-source &amp; MIT-licensed — no commercial license, no per-seat fee
          </motion.a>

          <motion.h1
            variants={item}
            className="mt-6 text-4xl font-semibold tracking-tight text-balance sm:text-5xl md:text-6xl lg:text-7xl"
          >
            Run <span className="text-gradient">Node.js</span>{" "}
            <br className="hidden md:block" />
            fully in the browser.
          </motion.h1>

          <motion.p variants={item} className="mt-6 max-w-xl text-lg text-muted">
            Vivari is a WebContainer you can embed: a virtual filesystem, a
            Node-compatible runtime, and virtual networking — all client-side.
            Boot a project, <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-sm text-fg">npm install</code>,
            run a dev server, and preview it live. No backend does the work.
          </motion.p>

          <motion.p variants={item} className="mt-4 max-w-xl text-sm text-muted/80">
            <span className="text-fg">Vivari</span>{" "}
            <span className="font-mono text-xs">(vih-VAH-ree)</span> — from the
            Latin <em>vivarium</em>, a self-contained enclosure for living things.
          </motion.p>

          <motion.div variants={item} className="mt-8 flex flex-wrap items-center gap-3">
            <a
              href={site.studioUrl}
              className="group inline-flex items-center gap-2 rounded-xl bg-fg px-5 py-3 font-medium text-bg transition-transform hover:scale-[1.03]"
            >
              Launch the Studio
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
            </a>
            <a
              href={site.docsUrl}
              className="glass inline-flex items-center gap-2 rounded-xl px-5 py-3 font-medium text-fg transition-colors hover:bg-white/5"
            >
              <BookOpen className="h-4 w-4" />
              Read the docs
            </a>
          </motion.div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.8, ease: "easeOut", delay: 0.2 }}
          className="animate-float"
        >
          <Workspace />
        </motion.div>
      </div>
    </section>
  );
}