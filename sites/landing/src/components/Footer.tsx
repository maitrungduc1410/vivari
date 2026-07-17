import { Github } from "lucide-react";
import { site } from "@/site";
import { Logo } from "./Logo";

export function Footer() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 px-6 py-10 sm:flex-row">
        <div className="flex items-center gap-2">
          <Logo className="h-6 w-6" />
          <span className="font-medium">{site.name}</span>
          <span className="text-sm text-faint">· MIT-licensed</span>
        </div>

        <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-muted">
          <a href={site.docsUrl} className="hover:text-fg">Docs</a>
          <a href={site.studioUrl} className="hover:text-fg">Studio</a>
          <a href={site.npmCoreUrl} target="_blank" rel="noreferrer" className="hover:text-fg">npm</a>
          <a
            href={site.githubUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 hover:text-fg"
          >
            <Github className="h-4 w-4" />
            GitHub
          </a>
        </nav>
      </div>
    </footer>
  );
}
