import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Github, ArrowUpRight } from "lucide-react";
import { site } from "@/site";
import { Logo } from "./Logo";

const links = [
  { label: "Features", href: "#features" },
  { label: "How it works", href: "#how" },
  { label: "Embed", href: "#embed" },
  { label: "Docs", href: site.docsUrl },
];

export function Nav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <motion.header
      initial={{ y: -24, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.6, ease: "easeOut" }}
      className="fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-4"
    >
      <nav
        className={`flex w-full max-w-7xl items-center justify-between rounded-2xl px-4 py-2.5 transition-colors duration-300 ${
          scrolled ? "glass shadow-lg shadow-black/40" : "border border-transparent"
        }`}
      >
        <a href="#top" className="flex items-center gap-2 font-semibold tracking-tight">
          <Logo className="h-7 w-7" />
          <span className="text-lg">{site.name}</span>
        </a>

        <div className="hidden items-center gap-1 md:flex">
          {links.map((l) => (
            <a
              key={l.label}
              href={l.href}
              className="rounded-lg px-3 py-1.5 text-sm text-muted transition-colors hover:bg-white/5 hover:text-fg"
            >
              {l.label}
            </a>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <a
            href={site.githubUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="GitHub repository"
            className="rounded-lg p-2 text-muted transition-colors hover:bg-white/5 hover:text-fg"
          >
            <Github className="h-5 w-5" />
          </a>
          <a
            href={site.studioUrl}
            className="group inline-flex items-center gap-1 rounded-lg bg-fg px-3.5 py-1.5 text-sm font-medium text-bg transition-transform hover:scale-[1.03]"
          >
            Open Studio
            <ArrowUpRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </a>
        </div>
      </nav>
    </motion.header>
  );
}
