import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { serve } from '../server/main.ts';
import { AppServer } from '../server/adapter.ts';
import type { Page } from '@playwright/test';

async function findQuestion(page: Page, title: string) {
  await page.getByRole('button', { name: '查找对话', exact: true }).click();
  await page.getByRole('searchbox', { name: '查找当前对话' }).fill(title);
  await expect(page.locator('.search-hit .question-card')).toBeVisible();
  await page.getByRole('button', { name: '关闭查找' }).click();
}

test('async questions support explicit answers, failure recovery, queue receipts and persisted history', async ({page,context}) => {
  const dir = await mkdtemp('/tmp/viewer-questions-');
  const adapter = new AppServer({command:process.execPath,args:[path.resolve('test/fake-codex.ts')]});
  const app = await serve({roots:[dir],dataDir:dir+'/data',runtimeDir:dir+'/run',port:0,adapter});
  try {
    await page.goto(app.launchUrl);
    await page.locator('#welcome-new').click(); await page.locator('.folder').filter({hasText:dir}).click(); await page.locator('#folder-select').click();
    await expect(page.locator('#send')).toBeEnabled(); await page.locator('#prompt').fill('hold-tool'); await page.locator('#send').click();
    await expect(page.locator('#stop')).toBeVisible();
    const id = decodeURIComponent(new URL(page.url()).hash.slice(1));
    const questions = [{title:'历史最好的一条限定 DeepSeek，还是纳入所有模型？',options:['限定 DeepSeek 历史实验','纳入所有模型的历史实验']},{title:'对图还有什么要求？'}];
    const detailAnswer = '保持 500 点与既定 token 预算\n\n补充：保留 <原始结果>。';
    const submitted = '1. 限定 DeepSeek 历史实验\n2. ' + detailAnswer;
    await adapter.call('mock/question',{threadId:id,questions});
    const card = page.locator('.question-card').first();
    await expect(card).toContainText('待回答 · Codex 可继续执行');
    await expect(page.locator('.approval')).toHaveCount(0);
    await expect(card.getByRole('button',{name:'发送回答'})).toBeDisabled();
    const requests: Record<string,unknown>[] = [];
    page.on('request', request => { if(request.method()==='POST' && request.url().endsWith('/turns')) requests.push(request.postDataJSON()); });
    await card.getByRole('button',{name:'限定 DeepSeek 历史实验',exact:true}).click();
    await expect(card.getByRole('button',{name:'限定 DeepSeek 历史实验',exact:true})).toHaveAttribute('aria-pressed','true');
    await expect(card.getByRole('button',{name:'发送回答'})).toBeDisabled(); expect(requests).toHaveLength(0);
    await card.getByLabel(questions[1]!.title).fill(detailAnswer);
    await page.locator('#prompt').fill('下一项工作的草稿');
    await page.locator('#files').setInputFiles({name:'draft.txt',mimeType:'text/plain',buffer:Buffer.from('attachment draft')});
    await expect(page.locator('#attachments')).toContainText('draft.txt');
    await page.reload(); await expect(card.getByLabel(questions[1]!.title)).toHaveValue(detailAnswer);
    await expect(page.locator('#prompt')).toHaveValue('下一项工作的草稿');
    // Attachment drafts intentionally do not survive reload; add one to verify answer isolation.
    await page.locator('#files').setInputFiles({name:'draft.txt',mimeType:'text/plain',buffer:Buffer.from('attachment draft')});
    await expect(page.locator('#attachments')).toContainText('draft.txt');
    await page.setViewportSize({width:1920,height:844}); await card.scrollIntoViewIfNeeded();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({path:'test-results/questions-widescreen.png',fullPage:true});
    await page.route('**/api/threads/*/turns', route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'当前轮次已变化，回答未发送'})}));
    await card.getByRole('button',{name:'发送回答'}).click(); await expect(card.getByRole('alert')).toContainText('回答未发送');
    await expect(card.getByLabel(questions[1]!.title)).toHaveValue(detailAnswer);
    await page.unroute('**/api/threads/*/turns');
    await card.getByRole('button',{name:'发送回答'}).click();
    await expect(card).toContainText('回答已排队，等待 Codex 接收');
    await expect(card.locator('.question-answer-text')).toHaveText(submitted); await expect(card.locator('textarea')).toHaveCount(0);
    expect(requests.at(-1)!.delivery).toBe('steer'); expect(requests.at(-1)!.attachments).toEqual([]); expect(requests.at(-1)!.skills).toEqual([]);
    await expect(page.locator('#prompt')).toHaveValue('下一项工作的草稿'); await expect(page.locator('#attachments')).toContainText('draft.txt');
    // Submitted answers survive missing local drafts, using the queue and then native history.
    await page.evaluate(id => localStorage.removeItem('viewer-answers:' + id), id);
    await page.reload(); await expect(card).toContainText('回答已排队，等待 Codex 接收');
    await expect(card.locator('.question-answer-text')).toHaveText(submitted);
    const snapshot = await (await page.request.get(app.origin+'/api/threads/'+id)).json();
    await adapter.call('mock/release',{threadId:id,turnId:snapshot.thread.turns[0].id});
    await expect(card).toContainText('回答已被 Codex 接收'); await expect(page.locator('#stop')).toBeHidden();
    await expect(card.locator('.question-answer-text')).toHaveText(submitted);
    await expect(page.locator('.message.user').filter({hasText:'回答 Codex 提问：'})).toHaveCount(1);
    await page.reload(); await findQuestion(page, questions[0]!.title); await expect(card).toContainText('回答已被 Codex 接收');
    expect(await card.locator('.question-answer-text').textContent()).toBe(submitted);
    await card.scrollIntoViewIfNeeded(); await page.screenshot({path:'test-results/questions-received-desktop.png',fullPage:true});
    const second = await context.newPage(); await second.goto(page.url()); await findQuestion(second, questions[0]!.title); await expect(second.locator('.question-card').first()).toContainText('回答已被 Codex 接收'); await expect(second.locator('.question-answer-text').first()).toHaveText(submitted); await second.close();
    // A question from a completed turn can be answered with a normal new turn.
    await adapter.call('mock/question',{threadId:id,questions:[{title:'还需要什么格式？',options:['PDF','SVG']}]});
    await findQuestion(page, '还需要什么格式？');
    const followup = page.locator('.question-card').last(); await expect(followup).toContainText('本轮已结束 · 仍可回答');
    await followup.getByRole('button',{name:'SVG',exact:true}).click(); await followup.getByRole('button',{name:'发送回答'}).click();
    await expect(followup).toContainText('回答已被 Codex 接收'); expect(requests.at(-1)!.delivery).toBe('start');
    await expect(followup.locator('.question-answer-text')).toHaveText('1. SVG');
    await expect(page.locator('#prompt')).toHaveValue('下一项工作的草稿');
    await page.setViewportSize({width:1280,height:1000}); await followup.scrollIntoViewIfNeeded();
    await page.screenshot({path:'test-results/questions-desktop.png',fullPage:true});
  } finally { await app.stop(); await rm(dir,{recursive:true,force:true}); }
});
