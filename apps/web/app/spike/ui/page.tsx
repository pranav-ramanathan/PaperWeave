import { BoldIcon, ItalicIcon, PlusIcon, Redo2Icon, Undo2Icon } from 'lucide-react';
import { notFound } from 'next/navigation';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../../../components/ui/card';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { NativeSelect, NativeSelectOption } from '../../../components/ui/native-select';
import { Separator } from '../../../components/ui/separator';
import { Textarea } from '../../../components/ui/textarea';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../../components/ui/tooltip';

export const metadata = { title: 'Specimen of the new look' };
export const dynamic = 'force-dynamic';

const VARIANTS = ['default', 'outline', 'secondary', 'ghost', 'destructive', 'link'] as const;
const SIZES = ['xs', 'sm', 'default', 'lg'] as const;
// What each variant's hover looks like, as classes, so that it can be seen (and audited) without a pointer.
const HOVERED: Record<(typeof VARIANTS)[number], string> = {
  default: 'bg-primary/90',
  outline: 'bg-muted',
  secondary: 'bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_8%)]',
  ghost: 'bg-muted',
  destructive: 'bg-destructive/10',
  link: 'no-underline',
};
// The focus ring as :focus-visible draws it (next.css), as classes.
const FOCUSED = 'outline-2 outline-offset-2 outline-ring';

const label = (v: string) => v[0].toUpperCase() + v.slice(1);

/**
 * Every component of components/ui in every state, in the new look, light only for now. A
 * workbench for developers like /spike: it is where the look's building blocks are seen together,
 * and what tests/e2e/specimen.spec.ts audits.
 */
export default async function Page() {
  if (process.env.SPIKE !== '1') notFound();
  return (
    <main data-ui="next" className="mx-auto max-w-4xl px-4 py-8">
      <TooltipProvider>
        <h1 className="font-heading text-3xl font-[650]">Specimen of the new look</h1>
        <p className="mt-2 max-w-prose text-muted-foreground">
          The building blocks in components/ui, each in each of its states. Hover and focus are
          drawn with classes, so that they show without a pointer or a keyboard.
        </p>

        <section aria-labelledby="buttons" className="mt-10">
          <h2 id="buttons" className="font-heading text-xl font-[650]">
            Buttons
          </h2>
          <Separator className="my-3" />
          {(['Default', 'Hover', 'Focus visible', 'Disabled', 'Invalid'] as const).map((state) => (
            <div key={state} className="mb-5">
              <h3 className="mb-2 font-[550]">{state}</h3>
              <div className="flex flex-wrap items-center gap-3">
                {VARIANTS.map((v) => (
                  <Button
                    key={v}
                    variant={v}
                    className={
                      state === 'Hover' ? HOVERED[v] : state === 'Focus visible' ? FOCUSED : ''
                    }
                    disabled={state === 'Disabled'}
                    aria-invalid={state === 'Invalid' ? true : undefined}
                  >
                    {label(v)}
                  </Button>
                ))}
              </div>
            </div>
          ))}
          <h3 className="mb-2 font-[550]">Sizes</h3>
          <div className="flex flex-wrap items-center gap-3">
            {SIZES.map((s) => (
              <Button key={s} size={s} variant="outline">
                {label(s)}
              </Button>
            ))}
            <Button size="default">
              <PlusIcon data-icon="inline-start" aria-hidden="true" />
              With an icon
            </Button>
          </div>
          <h3 className="mt-5 mb-2 font-[550]">Icon buttons, with tooltips</h3>
          <div className="flex flex-wrap items-center gap-3">
            {(
              [
                ['Bold', 'Ctrl+B', BoldIcon],
                ['Emphasise', 'Ctrl+I', ItalicIcon],
                ['Undo', 'Ctrl+Z', Undo2Icon],
                ['Redo', 'Ctrl+Shift+Z', Redo2Icon],
              ] as const
            ).map(([name, keys, Icon]) => (
              <Tooltip key={name}>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label={name}>
                    <Icon aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {name} {keys}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        </section>

        <section aria-labelledby="fields" className="mt-10">
          <h2 id="fields" className="font-heading text-xl font-[650]">
            Fields
          </h2>
          <Separator className="my-3" />
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="f-name">Name</Label>
              <Input id="f-name" placeholder="A short title" />
              <p className="text-[0.8125rem] text-muted-foreground">Shown in the list of papers.</p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="f-focus">Focus visible</Label>
              <Input id="f-focus" defaultValue="With the focus ring" className={FOCUSED} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="f-disabled">Disabled</Label>
              <Input id="f-disabled" defaultValue="Not now" disabled />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="f-invalid">Invalid</Label>
              <Input
                id="f-invalid"
                defaultValue="not an address"
                aria-invalid="true"
                aria-describedby="f-invalid-why"
              />
              <p id="f-invalid-why" className="text-[0.8125rem] text-destructive">
                Problem: that is not an email address.
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="f-text">Textarea</Label>
              <Textarea id="f-text" placeholder="What changed, in a sentence" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="f-text-invalid">Textarea, invalid</Label>
              <Textarea id="f-text-invalid" defaultValue="Too short" aria-invalid="true" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="f-text-disabled">Textarea, disabled</Label>
              <Textarea id="f-text-disabled" defaultValue="Read only for now" disabled />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="f-select">Select, a real select</Label>
              <NativeSelect id="f-select" defaultValue="line" wrapperClassName="w-full">
                <NativeSelectOption value="line">Line</NativeSelectOption>
                <NativeSelectOption value="bar">Bar</NativeSelectOption>
                <NativeSelectOption value="scatter">Scatter</NativeSelectOption>
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="f-select-small">Select, small</Label>
              <NativeSelect id="f-select-small" size="sm" wrapperClassName="w-full">
                <NativeSelectOption value="a">First</NativeSelectOption>
                <NativeSelectOption value="b">Second</NativeSelectOption>
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="f-select-focus">Select, focus visible</Label>
              <NativeSelect id="f-select-focus" wrapperClassName="w-full" className={FOCUSED}>
                <NativeSelectOption value="a">First</NativeSelectOption>
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="f-select-disabled">Select, disabled</Label>
              <NativeSelect id="f-select-disabled" disabled wrapperClassName="w-full">
                <NativeSelectOption value="a">First</NativeSelectOption>
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="f-select-invalid">Select, invalid</Label>
              <NativeSelect id="f-select-invalid" aria-invalid="true" wrapperClassName="w-full">
                <NativeSelectOption value="a">First</NativeSelectOption>
              </NativeSelect>
            </div>
          </div>
        </section>

        <section aria-labelledby="badges" className="mt-10">
          <h2 id="badges" className="font-heading text-xl font-[650]">
            Badges
          </h2>
          <Separator className="my-3" />
          <div className="flex flex-wrap items-center gap-3">
            <Badge>Default</Badge>
            <Badge variant="secondary">Secondary</Badge>
            <Badge variant="destructive">Destructive</Badge>
            <Badge variant="outline">Outline</Badge>
            <Badge variant="comment">Comment</Badge>
            <Badge variant="proposal">Proposed change</Badge>
            <Badge variant="finding">Spelling</Badge>
            <Badge variant="model">Model review</Badge>
            <Badge variant="ok">The PDF is up to date.</Badge>
          </div>
        </section>

        <section aria-labelledby="cards" className="mt-10">
          <h2 id="cards" className="font-heading text-xl font-[650]">
            Cards
          </h2>
          <Separator className="my-3" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>New paper</CardTitle>
                <CardDescription>Start from a template or an empty paper.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-1.5">
                <Label htmlFor="c-name">Title</Label>
                <Input id="c-name" />
              </CardContent>
              <CardFooter className="gap-2">
                <Button>Create paper</Button>
                <Button variant="outline">Cancel</Button>
              </CardFooter>
            </Card>
            <Card size="sm">
              <CardHeader>
                <CardTitle>A smaller card</CardTitle>
                <CardDescription>With less space inside.</CardDescription>
              </CardHeader>
              <CardContent>
                <Badge variant="proposal">Proposed change</Badge>
              </CardContent>
            </Card>
          </div>
        </section>

        <section aria-labelledby="rules" className="mt-10">
          <h2 id="rules" className="font-heading text-xl font-[650]">
            Separators
          </h2>
          <div className="mt-3 flex h-6 items-center gap-3 text-sm">
            <span>Files</span>
            <Separator orientation="vertical" />
            <span>Review</span>
            <Separator orientation="vertical" />
            <span>PDF</span>
          </div>
        </section>
      </TooltipProvider>
    </main>
  );
}
