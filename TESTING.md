Here I will test the chatbot's behavior.

Observations until now:

1. It searches every time using the user propmt as search input. Not good. It should decide when it's the case to search and when it's not. For instance, if the user says "Hi", it should not search for anything.

2. It uses thinking all the time. It should have a module which decides if the question is complex enough to employ thinking or not. But we shoulod have a "thinking" checkbox in the interface which should force thinking every time, because reading the thinking process is useful for me to understand what the robot is doing and what are the difficulties it faces. The thinking box should be open by default. 

3. When asked:
"what temperature is in Bucharest right now?"
It made a search. But it took only the values for the temperature at night from the search results.
If I make the same search with the testing search interface of the RAG engine (http://127.0.0.1:3001/dev/search/ui), and click on "Run Exa seaarch + extract", I get correct results in the "Extract stage" field for the current hour. Why does the robot present the temperatures for the night time? Doesn't it know what time it is?

4. When asked:
"who was Louis Malle?" it searches and gives correct answers. But when another question follows about the same subject without specifying it: "With which women did he have relationships and how many children did he have?" the robot doesn't find anything and relies on its general knowledge, which of course is hallucinated. I think it searches literally for "With which women did he have relationships and how many children did he have?" instead of combining the two questions and search for "With which women did Louis Malle have relationships and how many children did he have?". 
The chat orchestrator should employ the Utility LLM (for now we have only one LLM that should function as both Utility and Primary) to analyze the previous prompts and generally the knowledge of the whole conversation, and ask the LLM to build a proper search prompt based on what was discussed before.
I propose building a whole "prompt builder" module. It should decide how many LLM interrogations are needed to build the prompt: 
a. synthetize from the last several turns of the conversation a summary of the most important facts discussed (this could be an operation performed anyway by the Context Fragmenter, and in this case the prompt builder would just retrieve this from a table) and 
b. employ the LLM to build a search prompt adding in the mix the current date and time (we should have a function that takes this from the system it runs on - in the case of swirlock-chatbot-ui, the current date and time should trickle down from the frontend machine to the chat orchestrator server and further to the rag engine). On mobile, the app should ask the user for location permissions if they want to have more accurate search results.
