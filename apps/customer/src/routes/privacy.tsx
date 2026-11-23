import { createFileRoute } from "@tanstack/react-router";
import { PolicyPage, type PolicySection } from "@/components/PolicyPage";
import clusterGreen from "@/assets/decor/cluster-green.webp";
import { seo, breadcrumbLd } from "@/lib/seo";

export const Route = createFileRoute("/privacy")({
  head: () =>
    seo({
      title: "Privacy Policy — Mrs. Samuel Fruit Juice",
      description:
        "What personal information Mrs. Samuel Fruit Juice collects when you order or message us, how we use it, who we share it with, and how to ask us to delete it.",
      path: "/privacy",
      jsonLd: [breadcrumbLd([{ name: "Home", path: "/" }, { name: "Privacy Policy", path: "/privacy" }])],
    }),
  component: Page,
});

const sections: PolicySection[] = [
  {
    heading: "Who we are",
    body: [
      "Mrs. Samuel Fruit Juice (\"Mrs. Samuel\", \"we\", \"us\") is a cold-pressed fruit juice business based in Lagos, Nigeria. This policy explains what personal information we collect, why, and the choices you have. It applies to this website, our shop, and our conversations with you on WhatsApp, Instagram, Facebook Messenger and by phone.",
    ],
  },
  {
    heading: "What we collect",
    body: ["We only collect what we need to take your order, deliver it and look after you as a customer."],
    bullets: [
      "Contact details: your name, phone number and, if you give it, your email address.",
      "Delivery details: your delivery address and any delivery notes.",
      "Order details: what you ordered, when, how much you paid and whether it was delivered.",
      "Messages: what you send us on WhatsApp, Instagram or Facebook Messenger, and what we reply, including photos, voice notes and documents you choose to send.",
      "Phone calls: the number you call from, the time and length of the call, voicemails you leave, and a recording of the call where we tell you it is being recorded.",
      "Enquiries: what you tell us in our contact, bulk-order and white-label forms.",
      "Basic technical information: your basket and your order lookups are remembered on your own device so the site works, and our hosting provider records standard details such as IP address to keep the site secure.",
    ],
  },
  {
    heading: "What we do not collect",
    body: [
      "We never see or store your full card details. Online payments are handled on our payment provider's secure page. Please do not send card numbers, PINs or passwords to us in a chat.",
    ],
  },
  {
    heading: "How we use your information",
    body: ["We use your information to:"],
    bullets: [
      "Prepare, deliver and confirm your orders, and send you updates about them.",
      "Answer your questions and sort out problems.",
      "Keep our records, including the accounting records the law requires.",
      "Prevent fraud and keep our systems secure.",
      "Improve our products and service, for example by seeing which flavours are popular and what customers ask about.",
      "Send you offers or news, but only if you have agreed to receive them. You can stop these at any time.",
    ],
  },
  {
    heading: "Marketing and opting out",
    body: [
      "We only send marketing messages to people who have agreed to them. To stop, reply STOP to any marketing message, or tell us on WhatsApp, by phone or by email. Stopping marketing does not stop messages about an order you have placed.",
    ],
  },
  {
    heading: "Automated help",
    body: [
      "We may use software, including artificial intelligence, to help our team work faster, for example to summarise a call or to suggest a reply for a member of staff to check. You can always ask to deal with a person. We do not sell your information, and we do not allow your messages to be used to train anyone else's artificial intelligence models.",
    ],
  },
  {
    heading: "Who we share it with",
    body: [
      "We do not sell your personal information. We share it only with the companies that help us run the business, and only as far as they need it to do their job:",
    ],
    bullets: [
      "Our payment provider, to take your payment.",
      "Delivery riders and delivery partners, who need your name, phone number and address to bring your order.",
      "Meta (WhatsApp, Instagram and Facebook), when you choose to message us on those services.",
      "Our phone service provider, when you call us.",
      "The companies that host our website, store our files and send our emails.",
      "Authorities, where the law requires it.",
    ],
  },
  {
    heading: "How long we keep it",
    body: [
      "We keep order and payment records for as long as tax and accounting law requires. We keep messages, call recordings and enquiry details for as long as they are useful for serving you, and delete them when they are no longer needed or when you ask us to, unless the law requires us to keep them.",
    ],
  },
  {
    heading: "Keeping it safe",
    body: [
      "Our systems are protected by passwords and access controls, so only staff who need your information to do their job can see it. Connections to our website are encrypted. No system is perfectly secure, but we take reasonable care, and we will tell you and the regulator if a breach puts your information at risk.",
    ],
  },
  {
    heading: "Your rights",
    body: ["Under the Nigeria Data Protection Act you can ask us to:"],
    bullets: [
      "Tell you what personal information we hold about you and give you a copy.",
      "Correct anything that is wrong or out of date.",
      "Delete your information.",
      "Stop using your information for marketing, or withdraw a consent you gave earlier.",
      "If you are unhappy with how we have handled your information, you can also complain to the Nigeria Data Protection Commission.",
    ],
  },
  {
    heading: "How to ask us to delete your data",
    body: [
      "Send us a message on WhatsApp at 0901 951 2246 or an email to info@mrssamuel.com with the words \"delete my data\" and the phone number you used with us. We will confirm it is you, delete your messages, call records and contact details within 30 days, and tell you when it is done.",
      "We may need to keep records of orders and payments where the law requires it. We will tell you if that applies.",
    ],
  },
  {
    heading: "Children",
    body: [
      "Our website and services are for adults. We do not knowingly collect personal information from children.",
    ],
  },
  {
    heading: "Changes to this policy",
    body: [
      "If we change this policy we will update the date at the top of this page. If a change is significant, we will tell customers we are in contact with.",
    ],
  },
  {
    heading: "Contact us",
    body: [
      "Questions about your privacy? Reach us on WhatsApp at 0901 951 2246, by email at info@mrssamuel.com, or visit us at 30 Asa Afariogun Street, opposite Access Bank, Ajao Estate, Lagos.",
    ],
  },
];

function Page() {
  return (
    <PolicyPage
      eyebrow="Your Information"
      title={
        <>
          Privacy <span className="text-[color:var(--brand-orange)]">Policy</span>
        </>
      }
      subtitle="What we collect when you order or message us, what we do with it, and how to ask us to delete it. In plain language."
      decor={clusterGreen}
      accent="#2f9e5f"
      lastUpdated="18 November 2026"
      sections={sections}
    />
  );
}
