// deno-lint-ignore-file no-explicit-any

import Queue from 'npm:p-queue@latest'
import _ from "npm:lodash@4.17";
import {
  DOMParser,
  HTMLDocument,
} from "https://deno.land/x/deno_dom/deno-dom-wasm.ts";
import { parse } from "https://deno.land/std@0.182.0/flags/mod.ts";

interface Firm {
  id: string | undefined;
  name: string | undefined;
  quarters: Quarter[];
  clients: Client[]
}

interface Client {
  name: string | undefined;
  amount: number | undefined;
}

interface Quarter {
  quarter: string | undefined;
  session: string | undefined;
  amount: number | undefined;
}

const args = parse(Deno.args);
const concurrency = 4
const queue = new Queue({ concurrency })
const firms: Firm[] = []
const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0'
const session = args.session ? +args.session : 2023

const headers = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X x.y; rv:42.0) Gecko/20100101 Firefox/42.0'
}

async function scrapeLobbyingFirmsForLetter(letter: string): Promise<Firm> {
  console.log(`Scraping lobbying firms for ${letter}`)
  const url = `https://cal-access.sos.ca.gov/Lobbying/Firms/list.aspx?letter=${letter}&session=${session}`
  const response = await fetch(url, { headers })
  const html = await response.text()
  const document: HTMLDocument | null = new DOMParser().parseFromString(
    html,
    "text/html",
  );

  const data: Firm[] = []
  const rows = document?.querySelectorAll('#firms tbody tr')

  rows?.forEach((row, i) => {
    if (i === 0) return
    const cells = row?.querySelectorAll('td')
    const name = cells[0].innerText
    const link = cells[0].querySelector('a')
    const href = link.getAttribute('href')
    const id = href.split('id=')[1].split('&')[0]
    data.push({
      id,
      name,
      clients: [],
      quarters: []
    })
  })

  return data
}

async function scrapeLobbyingFirmFinancialActivity(id: string, session: string) {
  console.log(`Scraping financial history for ${id}`)
  const url = `https://cal-access.sos.ca.gov/Lobbying/Firms/Detail.aspx?id=${id}&view=activity&session=${session}`
  const response = await fetch(url, { headers })
  const html = await response.text()
  const document: HTMLDocument | null = new DOMParser().parseFromString(
    html,
    "text/html",
  );

  const tbodies = document?.querySelectorAll('tbody')
  const payments = tbodies[6]
  const clientsTable = tbodies[7]

  if (!clientsTable) {
    console.log(`No lobbying activity for ${id}`)
    return []
  }

  const paymentRows = payments.querySelectorAll('tr')
  const clientRows = clientsTable.querySelectorAll('tr')

  const clients: Client[] = []
  const quarters: Quarter[] = []

  for (let i = 2; i < clientRows.length; i++) {
    const paymentCells = clientRows[i].querySelectorAll('td')
    const name = paymentCells[0].innerText.trim()
    const amount = +paymentCells[2].innerText.replaceAll(',', '').replace('$', '')

    clients.push({
      name,
      amount,
    })
  }

  for (let i = 2; i < paymentRows.length; i++) {
    const paymentCells = paymentRows[i].querySelectorAll('td')
    const firstCellText = paymentCells[0].innerText.trim()
    const [session, quarter] = firstCellText.split(', QUARTER ')
    const amount = +paymentCells[1].innerText.replaceAll(',', '').replace('$', '')

    quarters.push({
      quarter,
      session,
      amount,
    })
  }

  return { clients, quarters }
}

console.log(`Scraping for the ${session}-${session + 1} session`)

letters.split('').forEach(letter => {
  queue.add(async () => {
    const firmsForLetter: Firm[] = await scrapeLobbyingFirmsForLetter(letter)
    firms.push(...firmsForLetter)
  })
})

await queue.onIdle()

if (firms.length === 0) {
  console.log('Found zero lobbying firms - something messed up and not going to save anything')
  Deno.exit(0)
}

firms.forEach(firm => {
  queue.add(async () => {
    try {
      const { clients, quarters } = await scrapeLobbyingFirmFinancialActivity(firm.id, session)
      firm.clients = _.orderBy(clients, ['name'])
      firm.quarters = _.orderBy(quarters, ['session', 'quarter'])
    } catch (e) {
      console.error(`Error scraping financial activity for ${firm.id}`, e)
    }
  })
})

await queue.onIdle()

console.log(`Sorting`)
const sorted = _.orderBy(firms, ["name", "id"]);
const fileName = `lobbying-firms-financial-activity-${session}.json`
console.log(`Saving to ${fileName}`);
await Deno.writeTextFile(`./${fileName}`, JSON.stringify(sorted, null, 2));
console.log(`All done`);
