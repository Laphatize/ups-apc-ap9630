import axios from 'axios';
import { JSDOM } from 'jsdom';

class DefaultUPS {
    constructor(host, username, password) {
        this.host = host;
        this._username = username;
        this._password = password;
    }
}

let UPS_APC_API;
try {
    // Using dynamic import wouldn't work in this context, so we'll use require
    const importedModule = require('@trickfilm400/ups-apc-ap9630');
    UPS_APC_API = importedModule.UPS_APC_API;
} catch (error) {
    UPS_APC_API = DefaultUPS;
}

export class UPSClient2200 extends UPS_APC_API {
  constructor(host, username, password) {
    super(host, username, password);
    this.customAxios = axios.create({
      baseURL: `http://${host}/`,
      timeout: 10000,
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status <= 400
    });
    this.sessionId = null;
  }

  async login() {
    try {
      console.log('Attempting to login to UPS...');
      
      // Get the login page
      const loginPageResponse = await this.customAxios.get('/');
      const loginPageHtml = loginPageResponse.data;
      console.log('Got login page response');
      
      // Create DOM from response
      const loginDom = new JSDOM(loginPageHtml);
      const doc = loginDom.window.document;
      
      // Try to find the form using various selectors
      let loginForm = doc.querySelector('form[name="frmLogin"]');
      
      if (!loginForm) {
        loginForm = doc.querySelector('form[action*="login"]');
      }
      
      if (!loginForm) {
        loginForm = doc.querySelector('form');
      }
      
      if (!loginForm) {
        console.error('Login form not found in HTML. Using fallback approach');
        // If we can't find a form, use a hardcoded fallback path
        return this.loginWithFallback();
      }
      
      // Extract the form action path
      let formAction = loginForm.getAttribute('action');
      
      console.log('Found form with action:', formAction);
      
      // If form action is relative, ensure it starts with a slash
      if (formAction && !formAction.startsWith('http') && !formAction.startsWith('/')) {
        formAction = '/' + formAction;
      }
      
      // Prepare form data
      const formData = new URLSearchParams();
      formData.append('login_username', this._username || 'apc');
      formData.append('login_password', this._password || 'apc');
      formData.append('prefLanguage', '00000000');
      formData.append('submit', 'Log On');
      
      console.log('Submitting login form to:', formAction);
      
      // Submit login form
      const response = await this.customAxios.post(formAction, formData, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });
      
      // Handle redirect to extract session ID
      if (response.status === 303 || response.headers.location) {
        const locationHeader = response.headers.location;
        console.log('Redirect location:', locationHeader);
        
        const sessionMatch = /(?:[/]?NMC\/)([^/]+)/.exec(locationHeader);
        if (sessionMatch && sessionMatch[1]) {
          this.sessionId = sessionMatch[1];
          console.log('Session ID:', this.sessionId);
          return this.sessionId;
        }
      }
      
      // If we didn't get a redirect or couldn't extract session ID, try fallback
      return this.loginWithFallback();
    } catch (error) {
      console.error('Login error:', error.message);
      return this.loginWithFallback();
    }
  }


  async getData() {
    try {
      // Ensure we have a session
      if (!this.sessionId) {
        await this.login();
      }
      
      // Try to fetch the status page
      console.log('Fetching UPS status page...');
      const statusPaths = [
        `/NMC/${this.sessionId}/ulstat.htm`,
        `/NMC/${this.sessionId}/upsstat.htm`,
        `/NMC/${this.sessionId}/status.htm`
      ];
      
      let html = null;
      
      // Try each status path
      for (const path of statusPaths) {
        try {
          console.log('Trying status path:', path);
          const response = await this.customAxios.get(path);
          if (response.status === 200) {
            html = response.data;
            console.log('Successfully fetched status page');
            break;
          }
        } catch (error) {
          console.log(`Failed with path ${path}:`, error.message);
          // Continue to next path
        }
      }
      
      // If we couldn't fetch any status page, try to login again and retry
      if (!html) {
        console.log('All status paths failed, trying to login again...');
        await this.login();
        
        // Try again with the first path
        const response = await this.customAxios.get(`/NMC/${this.sessionId}/ulstat.htm`);
        html = response.data;
      }
      
      // Parse the response HTML
      if (html) {
        return this.parseHTML(html);
      } else {
        throw new Error('Failed to fetch UPS status page');
      }
    } catch (error) {
      console.error('Failed to get UPS data:', error.message);
      throw error;
    }
  }

  parseHTML(html) {
    try {
      // Clean the HTML string
      const cleanHtml = html.replace(/\n/g, "");
      const dom = new JSDOM(cleanHtml);
      const doc = dom.window.document;
      
      // Initialize values
      let ampere = -1;
      let voltage = -1;
      let temperature = -1;
      let runtime = -1;
      
      // Try multiple approaches to extract data
      
      // 1. Try original selectors
      ampere = this.findValueBySelector(doc, '#langLoadCurrent');
      voltage = this.findValueBySelector(doc, '#langOutputVoltage');
      temperature = this.findValueBySelector(doc, '#langInternalTemp');
      runtime = this.findValueBySelector(doc, '#langRuntime');
      
      // 2. Try to find by table structure
      if (ampere === -1 || voltage === -1 || temperature === -1) {
        this.extractValuesFromTables(doc, (field, value) => {
          if (field === 'ampere' && ampere === -1) ampere = value;
          if (field === 'voltage' && voltage === -1) voltage = value;
          if (field === 'temperature' && temperature === -1) temperature = value;
          if (field === 'runtime' && runtime === -1) runtime = value;
        });
      }
      // 3. Try by searching all elements for relevant text
      if (ampere === -1 || voltage === -1 || temperature === -1) {
        this.extractValuesFromAllElements(doc, (field, value) => {
          if (field === 'ampere' && ampere === -1) ampere = value;
          if (field === 'voltage' && voltage === -1) voltage = value;
          if (field === 'temperature' && temperature === -1) temperature = value;
          if (field === 'runtime' && runtime === -1) runtime = value;
        });
      }
      
      // 4. If still not found, search the entire document text
      if (ampere === -1) {
        ampere = this.extractValueFromFullText(cleanHtml, ['load', 'current', 'ampere', 'amp']);
      }
      
      if (voltage === -1) {
        voltage = this.extractValueFromFullText(cleanHtml, ['voltage', 'volt', 'v']);
      }
      
      if (temperature === -1) {
        temperature = this.extractValueFromFullText(cleanHtml, ['temperature', 'temp', '°c']);
      }
      
      if (runtime === -1) {
        runtime = this.extractValueFromFullText(cleanHtml, ['runtime', 'time']);
      }
      
      ampere = ampere === -1 ? 0 : ampere;
      voltage = voltage === -1 ? 0 : voltage;
      temperature = temperature === -1 ? 0 : temperature;
      runtime = runtime === -1 ? 0 : runtime;

      // Calculate wattage
      const wattage = ampere !== 0 && voltage !== 0 
        ? Math.round((ampere * voltage + Number.EPSILON) * 100) / 100 
        : 0;
      
      if (runtime > 0) {
        // If runtime seems too small (less than 5 minutes), it might be in minutes already
        // Otherwise, convert from seconds to minutes
        if (runtime > 300) {
          // Convert from seconds to minutes if it seems to be in seconds
          runtime = runtime / 60;
        }
      }
      
      return {
        loadInAmpere: ampere,
        voltage: voltage,
        loadInWatt: wattage,
        temperature: temperature,
        runtime: runtime
      };
    } catch (error) {
      console.error('HTML parsing error:', error);
      // Return default values if parsing fails
      return {
        loadInAmpere: 0,
        voltage: 0,
        loadInWatt: 0,
        temperature: 0,
        runtime: 0,
        error: error.message
      };
    }
  }

  // Helper method to find values by selector
  findValueBySelector(doc, selector) {
    try {
      const element = doc.querySelector(selector);
      if (element) {
        const parent = element.parentElement?.parentElement;
        if (parent && parent.childNodes.item(1)) {
          const valueNode = parent.childNodes.item(1).firstChild;
          if (valueNode && valueNode.nodeValue) {
            const nodeValue = valueNode.nodeValue.trim();
            
            // If this is a temperature value, remove °C
            if (nodeValue.includes('°C')) {
              return parseFloat(nodeValue.replace('°C', ''));
            }
            
            // If this is a runtime value like "2hr 9min"
            if (nodeValue.includes('hr') || nodeValue.includes('min')) {
              return this.parseRuntimeString(nodeValue);
            }
            
            // For other values, just parse as float
            return parseFloat(nodeValue);
          }
        }
      }
      return -1;
    } catch (error) {
      return -1;
    }
  }
  
  // Helper method to parse runtime strings like "2hr 9min" to minutes
  parseRuntimeString(text) {
    try {
      let totalMinutes = 0;
      
      // Extract hours
      const hourMatch = text.match(/(\d+)\s*hr/);
      if (hourMatch && hourMatch[1]) {
        totalMinutes += parseInt(hourMatch[1]) * 60;
      }
      
      // Extract minutes
      const minuteMatch = text.match(/(\d+)\s*min/);
      if (minuteMatch && minuteMatch[1]) {
        totalMinutes += parseInt(minuteMatch[1]);
      }
      
      return totalMinutes;
    } catch (error) {
      console.error('Error parsing runtime string:', error);
      return -1;
    }
  }

  // Helper method to extract values from table structures
  extractValuesFromTables(doc, callback) {
    try {
      const tables = doc.querySelectorAll('table');
      
      for (const table of tables) {
        const rows = table.querySelectorAll('tr');
        
        for (const row of rows) {
          const text = row.textContent.toLowerCase();
          
          // Look for load or current or ampere
          if (text.includes('load') || text.includes('current') || text.includes('ampere')) {
            const value = this.extractNumberFromText(text);
            if (value !== -1) {
              callback('ampere', value);
            }
          }
          
          // Look for voltage
          if (text.includes('voltage') || text.includes('volt')) {
            const value = this.extractNumberFromText(text);
            if (value !== -1) {
              callback('voltage', value);
            }
          }
          
          // Look for temperature
          if (text.includes('temp') || text.includes('°c')) {
            const value = this.extractNumberFromText(text);
            if (value !== -1) {
              callback('temperature', value);
            }
          }
          
          // Look for runtime
          if (text.includes('runtime') || text.includes('run time') || text.includes('remaining')) {
            // Try to find runtime in "2hr 9min" format
            if (text.includes('hr') || text.includes('min')) {
              const value = this.parseRuntimeString(text);
              if (value !== -1) {
                callback('runtime', value);
                continue;
              }
            }
            
            // Fallback to number extraction
            const value = this.extractNumberFromText(text);
            if (value !== -1) {
              callback('runtime', value);
            }
          }
        }
      }
    } catch (error) {
      console.error('Error extracting from tables:', error);
    }
  }

  // Helper method to extract values from all elements
  extractValuesFromAllElements(doc, callback) {
    try {
      // Look specifically for the runtime remaining field based on the provided HTML
      const runtimeElement = doc.querySelector('#langRuntimeRemaining');
      if (runtimeElement) {
        const parent = runtimeElement.closest('.dataField');
        if (parent) {
          const valueDiv = parent.querySelector('.dataValue');
          if (valueDiv && valueDiv.textContent) {
            const runtimeValue = this.parseRuntimeString(valueDiv.textContent);
            if (runtimeValue !== -1) {
              callback('runtime', runtimeValue);
            }
          }
        }
      }
      
      // Continue with general element search
      const allElements = doc.querySelectorAll('*');
      
      for (const element of allElements) {
        const text = element.textContent.toLowerCase();
        
        // Process only non-empty elements with reasonable text length
        if (text && text.length > 0 && text.length < 100) {
          // Look for load or current or ampere
          if (text.includes('load') || text.includes('current') || text.includes('ampere')) {
            const value = this.extractNumberFromText(text);
            if (value !== -1) {
              callback('ampere', value);
            }
          }
          
          // Look for voltage
          if (text.includes('voltage') || text.includes('volt')) {
            const value = this.extractNumberFromText(text);
            if (value !== -1) {
              callback('voltage', value);
            }
          }
          
          // Look for temperature
          if (text.includes('temp') || text.includes('°c')) {
            const value = this.extractNumberFromText(text);
            if (value !== -1) {
              callback('temperature', value);
            }
          }
          
          // Look for runtime - special handling for "hr" and "min" format
          if (text.includes('runtime') || text.includes('run time') || text.includes('remaining')) {
            if (text.includes('hr') || text.includes('min')) {
              const value = this.parseRuntimeString(text);
              if (value !== -1) {
                callback('runtime', value);
                continue;
              }
            }
            
            // Fallback to regular number extraction
            const value = this.extractNumberFromText(text);
            if (value !== -1) {
              callback('runtime', value);
            }
          }
        }
      }
    } catch (error) {
      console.error('Error extracting from all elements:', error);
    }
  }

  // Helper method to extract from full document text
  extractValueFromFullText(text, keywords) {
    const lowerText = text.toLowerCase();
    
    for (const keyword of keywords) {
      const pos = lowerText.indexOf(keyword);
      
      if (pos !== -1) {
        // Look for numbers in the surrounding text (100 chars before and after)
        const start = Math.max(0, pos - 100);
        const end = Math.min(lowerText.length, pos + 100);
        const surroundingText = lowerText.substring(start, end);
        
        // Special handling for runtime 
        if (keyword === 'runtime' || keyword === 'remaining') {
          const hourMinPattern = /(\d+)\s*hr\s*(?:(\d+)\s*min)?/;
          const minPattern = /(\d+)\s*min/;
          
          const hourMinMatch = surroundingText.match(hourMinPattern);
          if (hourMinMatch) {
            let totalMinutes = parseInt(hourMinMatch[1]) * 60; // Hours to minutes
            
            // Add minutes if present
            if (hourMinMatch[2]) {
              totalMinutes += parseInt(hourMinMatch[2]);
            }
            
            return totalMinutes;
          }
          
          // Check for minutes-only pattern
          const minMatch = surroundingText.match(minPattern);
          if (minMatch) {
            return parseInt(minMatch[1]);
          }
        }
        
        // Default number extraction
        const value = this.extractNumberFromText(surroundingText);
        if (value !== -1) {
          return value;
        }
      }
    }
    
    return -1;
  }

  // Helper method to extract numbers from text
  extractNumberFromText(text) {
    const matches = text.match(/(\d+(\.\d+)?)/);
    return matches ? parseFloat(matches[0]) : -1;
  }

  // New method to get recent events
  async getEvents() {
    try {
      // Ensure we have a session
      if (!this.sessionId) {
        await this.login();
      }

      // First try to get events from the home page
      console.log('Fetching UPS events...');
      let html = null;
      
      // Try to fetch the home page which contains recent events
      try {
        const response = await this.customAxios.get(`/NMC/${this.sessionId}/home.htm`);
        if (response.status === 200) {
          html = response.data;
          console.log('Successfully fetched home page with events');
        }
      } catch (error) {
        console.log(`Failed to fetch home page: ${error.message}`);
      }
      
      // If home page failed, try the events page directly
      if (!html) {
        try {
          const response = await this.customAxios.get(`/NMC/${this.sessionId}/eventweb.htm`);
          if (response.status === 200) {
            html = response.data;
            console.log('Successfully fetched events page');
          }
        } catch (error) {
          console.log(`Failed to fetch events page: ${error.message}`);
        }
      }
      
      // Parse the events from HTML
      if (html) {
        return this.parseEvents(html);
      } else {
        throw new Error('Failed to fetch UPS events');
      }
    } catch (error) {
      console.error('Failed to get UPS events:', error.message);
      throw error;
    }
  }
  
  // Parse events from HTML
  parseEvents(html) {
    try {
      const dom = new JSDOM(html);
      const doc = dom.window.document;
      
      // Look for the events table
      const events = [];
      
      // First, try to find the "Recent Device Events" section
      const eventSections = Array.from(doc.querySelectorAll('.dataSubHeader'))
        .filter(el => el.textContent.toLowerCase().includes('recent device events') || 
                      el.textContent.toLowerCase().includes('event'));
      
      if (eventSections.length > 0) {
        // Find the closest table to this section header
        let eventSection = eventSections[0];
        let table = findClosestTable(eventSection);
        
        if (table) {
          // Process the table rows
          const rows = table.querySelectorAll('tr');
          // Skip the header row
          for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            const cells = row.querySelectorAll('td');
            
            if (cells.length >= 3) {
              const date = cells[0].textContent.trim();
              const time = cells[1].textContent.trim();
              const description = cells[2].textContent.trim();
              
              // Determine event type based on row class
              let type = 'info';
              if (row.classList.contains('text-success')) {
                type = 'success';
              } else if (row.classList.contains('text-warning')) {
                type = 'warning';
              } else if (row.classList.contains('text-danger')) {
                type = 'danger';
              }
              
              events.push({
                date,
                time,
                description,
                type,
                timestamp: new Date(`${date} ${time}`).getTime()
              });
            }
          }
        }
      }
      
      // Sort events by timestamp (newest first)
      events.sort((a, b) => b.timestamp - a.timestamp);
      
      return {
        events,
        count: events.length
      };
    } catch (error) {
      console.error('Error parsing events:', error);
      return {
        events: [],
        count: 0,
        error: error.message
      };
    }
    
    // Helper function to find the closest table to an element
    function findClosestTable(element) {
      // First check if there's a table in the parent container
      let current = element;
      let maxIterations = 5; // Limit how far up the DOM we go
      
      while (current && maxIterations > 0) {
        // Look for a table in siblings that come after this element
        let sibling = current.nextElementSibling;
        while (sibling) {
          if (sibling.tagName === 'TABLE' || sibling.querySelector('table')) {
            return sibling.tagName === 'TABLE' ? sibling : sibling.querySelector('table');
          }
          sibling = sibling.nextElementSibling;
        }
        
        // Move up to parent and check its siblings
        current = current.parentElement;
        maxIterations--;
      }
      
      // If we didn't find a table in the siblings, look for any table in the page
      return doc.querySelector('table');
    }
  }
} 
