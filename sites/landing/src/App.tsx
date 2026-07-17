import { Background } from "./components/Background";
import { Nav } from "./components/Nav";
import { Hero } from "./components/Hero";
import { Features } from "./components/Features";
import { HowItWorks } from "./components/HowItWorks";
import { Embed } from "./components/Embed";
import { Comparison } from "./components/Comparison";
import { CTA } from "./components/CTA";
import { Footer } from "./components/Footer";

export default function App() {
  return (
    <>
      <Background />
      <Nav />
      <main>
        <Hero />
        <Features />
        <HowItWorks />
        <Embed />
        <Comparison />
        <CTA />
      </main>
      <Footer />
    </>
  );
}
