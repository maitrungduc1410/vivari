import { motion } from "motion/react";
import { ArrowRight, BookOpen } from "lucide-react";
import { site } from "@/site";

export function CTA() {
  return (
    <section className="mx-auto max-w-5xl px-6 py-24">
      <motion.div
        initial={{ opacity: 0, scale: 0.97 }}
        whileInView={{ opacity: 1, scale: 1 }}
        viewport={{ once: true, margin: "-100px" }}
        transition={{ duration: 0.7, ease: "easeOut" }}
        className="relative overflow-hidden rounded-3xl border border-border p-12 text-center md:p-16"
      >
        <div className="absolute inset-0 -z-10 bg-gradient-to-br from-brand/20 via-brand-2/10 to-brand-3/20" />
        <div className="absolute inset-0 -z-10 animate-aurora bg-[radial-gradient(circle_at_30%_20%,rgba(124,92,255,0.35),transparent_55%)]" />

        <h2 className="text-3xl font-semibold tracking-tight md:text-5xl">
          Build the impossible tab.
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-muted">
          Spin up a real Node environment in your browser right now — no install,
          no sign-up, no server.
        </p>

        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <a
            href={site.studioUrl}
            className="group inline-flex items-center gap-2 rounded-xl bg-fg px-6 py-3 font-medium text-bg transition-transform hover:scale-[1.03]"
          >
            Open the Studio
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
          </a>
          <a
            href={site.docsUrl}
            className="glass inline-flex items-center gap-2 rounded-xl px-6 py-3 font-medium text-fg transition-colors hover:bg-white/5"
          >
            <BookOpen className="h-4 w-4" />
            Explore the docs
          </a>
        </div>
      </motion.div>
    </section>
  );
}
