// shadcn/ui composition patterns (MIT), styled with Nocheh semantic tokens.
import * as React from 'react';
import {Slot, Dialog, Tabs as TabsPrimitive, Tooltip as TooltipPrimitive, Progress as ProgressPrimitive} from 'radix-ui';
import {cva, type VariantProps} from 'class-variance-authority';
import {X, Inbox} from 'lucide-react';
import {cn} from '../../lib/utils';
const buttonVariants=cva('ui-button',{variants:{variant:{default:'ui-button-primary',outline:'ui-button-outline',ghost:'ui-button-ghost',destructive:'ui-button-destructive'},size:{default:'',sm:'ui-button-sm',icon:'ui-button-icon'}},defaultVariants:{variant:'outline',size:'default'}});
export function Button({className,variant,size,asChild=false,type='button',...props}:React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & {asChild?:boolean}){const Comp=asChild?Slot.Root:'button';return <Comp type={type} className={cn(buttonVariants({variant,size}),className)} {...props}/>;}
export function Badge({className,...props}:React.ComponentProps<'span'>){return <span className={cn('ui-badge',className)} {...props}/>;}
export function Alert({children,className,...props}:React.ComponentProps<'div'>){return <div role="alert" className={cn('ui-alert',className)} {...props}>{children}</div>;}
export function Skeleton({className,...props}:React.ComponentProps<'div'>){return <div aria-hidden="true" className={cn('ui-skeleton',className)} {...props}/>;}
export function EmptyState({title,children}:{title:string;children?:React.ReactNode}){return <div className="ui-empty"><Inbox aria-hidden="true"/><h3>{title}</h3>{children&&<p>{children}</p>}</div>;}
export function Progress({value,label}:{value:number;label:string}){const bounded=Math.max(0,Math.min(100,value));return <div className="ui-progress-wrap"><span>{label}</span><ProgressPrimitive.Root className="ui-progress" value={bounded} aria-label={label}><ProgressPrimitive.Indicator className="ui-progress-indicator" style={{transform:`translateX(-${100-bounded}%)`}}/></ProgressPrimitive.Root></div>;}
export const Tabs=TabsPrimitive.Root;
export function TabsList({className,...props}:React.ComponentProps<typeof TabsPrimitive.List>){return <TabsPrimitive.List className={cn('ui-tabs-list',className)} {...props}/>;}
export function TabsTrigger({className,...props}:React.ComponentProps<typeof TabsPrimitive.Trigger>){return <TabsPrimitive.Trigger className={cn('ui-tabs-trigger',className)} {...props}/>;}
export const TabsContent=TabsPrimitive.Content;
export function Tooltip({label,children}:{label:string;children:React.ReactNode}){return <TooltipPrimitive.Provider delayDuration={300}><TooltipPrimitive.Root><TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger><TooltipPrimitive.Portal><TooltipPrimitive.Content className="ui-tooltip" sideOffset={6}>{label}</TooltipPrimitive.Content></TooltipPrimitive.Portal></TooltipPrimitive.Root></TooltipPrimitive.Provider>;}
/** Radix wraps keyboard focus without scrolling; keep long panels usable. */
function revealPanelFocus(event:React.FocusEvent<HTMLDivElement>){
 const target=event.target,panel=event.currentTarget;
 if(!(target instanceof HTMLElement)||target===panel)return;
 // Run after the browser's own focus scrolling, including Radix's focus loop.
 requestAnimationFrame(()=>{
  if(!target.isConnected||document.activeElement!==target)return;
  const item=target.getBoundingClientRect(),bounds=panel.getBoundingClientRect();
  if(item.top<bounds.top+16)panel.scrollTop+=item.top-bounds.top-16;
  else if(item.bottom>bounds.bottom-16)panel.scrollTop+=item.bottom-bounds.bottom+16;
 });
}
export function Sheet({open,onOpenChange,title,description,children,side='right',returnFocus}:{open:boolean;onOpenChange:(open:boolean)=>void;title:string;description?:string;children:React.ReactNode;side?:'left'|'right';returnFocus?:HTMLElement|null}){const descriptionId=React.useId();return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="ui-overlay"/><Dialog.Content className={cn('ui-sheet',`ui-sheet-${side}`)} onFocusCapture={revealPanelFocus} onCloseAutoFocus={event=>{if(returnFocus?.isConnected){event.preventDefault();returnFocus.focus();}}} aria-describedby={description?descriptionId:undefined}><div className="ui-sheet-heading"><Dialog.Title>{title}</Dialog.Title><Dialog.Close asChild><Button size="icon" aria-label="Close panel"><X size={18}/></Button></Dialog.Close></div>{description&&<Dialog.Description id={descriptionId} className="ui-sheet-description">{description}</Dialog.Description>}{children}</Dialog.Content></Dialog.Portal></Dialog.Root>;}
export function Modal({open,onOpenChange,title,children,returnFocus}:{open:boolean;onOpenChange:(open:boolean)=>void;title:string;children:React.ReactNode;returnFocus?:HTMLElement|null}){return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="ui-overlay"/><Dialog.Content className="ui-modal" aria-describedby={undefined} onCloseAutoFocus={event=>{if(returnFocus?.isConnected){event.preventDefault();returnFocus.focus();}}}><Dialog.Title>{title}</Dialog.Title>{children}<Dialog.Close asChild><Button>Close</Button></Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>;}
export function Table({className,...props}:React.ComponentProps<'table'>){return <div className="ui-table-scroll" tabIndex={0} role="region" aria-label={props['aria-label']||'Data table'}><table className={cn('ui-table',className)} {...props}/></div>;}
